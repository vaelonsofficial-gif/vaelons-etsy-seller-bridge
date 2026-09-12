'use server';

import { revalidatePath } from 'next/cache';

import { prepareMetadataAction } from '../../../lib/control-center/actions.js';
import {
  appendGenerationEvent,
  getGeneration,
  updateGeneration
} from '../../../lib/control-center/store.js';

function failure(error) {
  return {
    ok: false,
    message: error?.message || 'Görev tamamlanamadı',
    code: error?.code || 'TASK_COMPLETION_FAILED',
    etsy_modified: false
  };
}

function summary(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 500);
}

export async function completeQueuedTask(_previousState, formData) {
  try {
    const taskId = String(formData.get('generation_id') || '');
    const task = await getGeneration(taskId);

    if (!task) {
      const error = new Error('Sezar görev kaydı bulunamadı');
      error.status = 404;
      error.code = 'TASK_NOT_FOUND';
      throw error;
    }

    if (!['QUEUED', 'BLOCKED'].includes(task.status)) {
      const error = new Error('Bu görev yeniden içerik kaydetmeye açık değil');
      error.status = 409;
      error.code = 'TASK_NOT_EDITABLE';
      throw error;
    }

    if (task.task_scope === 'CREATIVE_IMAGES') {
      const error = new Error('Bu görev görsel çalışma alanında tamamlanmalıdır');
      error.status = 409;
      error.code = 'VISUAL_TASK_REQUIRED';
      throw error;
    }

    const result = await prepareMetadataAction({
      listingId: task.listing_id,
      title: String(formData.get('title') || ''),
      tags: String(formData.get('tags') || '').split(/\r?\n/),
      description: String(formData.get('description') || ''),
      reason: `sezar_queue:${task.id}`,
      expectedBeforeHash: task.before_hash,
      strictClaims: true,
      source: 'SEZAR_REVIEW',
      generationId: task.id
    });

    const completedAt = new Date().toISOString();
    const valid = result.no_changes || result.validation.valid;
    const updated = await updateGeneration(task.id, {
      status: valid ? 'COMPLETED' : 'BLOCKED',
      summary: summary(formData.get('summary')) || (result.no_changes
        ? 'Listing incelendi; metadata değişikliği gerekmiyor.'
        : 'Sezar tarafından hazırlanan içerik doğrulandı.'),
      expected_outcome: result.no_changes
        ? 'Mevcut metadata korunacak.'
        : 'Onay verilirse yalnızca gösterilen metadata alanları Etsy’ye uygulanacak.',
      safety_notes: result.validation.warnings || [],
      proposal: result.validation.proposed,
      validation: result.validation,
      action_id: result.action?.id || null,
      action: result.action,
      completed_at: valid ? completedAt : null,
      etsy_modified: false
    });

    await appendGenerationEvent(task.id, {
      type: valid ? 'SEZAR_CONTENT_VALIDATED' : 'SEZAR_CONTENT_BLOCKED',
      status: updated.status,
      action_id: result.action?.id || null,
      external_ai_cost_usd: 0,
      etsy_modified: false
    });

    revalidatePath('/actions');
    revalidatePath(`/generations/${task.id}`);
    revalidatePath(`/listings/${task.listing_id}`);

    return {
      ok: valid,
      message: valid
        ? result.no_changes
          ? 'İnceleme tamamlandı; yayınlanacak metadata farkı bulunmadı.'
          : 'İçerik doğrulandı ve sahibin onay kuyruğuna alındı.'
        : 'İçerik güvenlik doğrulamasından geçemedi; Etsy’ye gönderilemez.',
      generation_id: task.id,
      listing_id: task.listing_id,
      action: result.action,
      validation: result.validation,
      etsy_modified: false
    };
  } catch (error) {
    return failure(error);
  }
}
