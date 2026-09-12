'use server';

import { revalidatePath } from 'next/cache';

import { completeListingContentTask } from '../../../lib/control-center/content-generator.js';

function failure(error) {
  return {
    ok: false,
    message: error?.message || 'Görev tamamlanamadı',
    code: error?.code || 'TASK_COMPLETION_FAILED',
    etsy_modified: false
  };
}

async function completeTask(taskId, formData) {
  try {
    const completion = await completeListingContentTask({
      taskId: String(taskId || ''),
      title: String(formData.get('title') || ''),
      tags: String(formData.get('tags') || '').split(/\r?\n/),
      description: String(formData.get('description') || ''),
      summary: String(formData.get('summary') || '')
    });
    const { task, result, valid } = completion;

    revalidatePath('/');
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

export async function completeQueuedTask(_previousState, formData) {
  return completeTask(formData.get('generation_id'), formData);
}

export async function completeBoundQueuedTask(taskId, _previousState, formData) {
  return completeTask(taskId, formData);
}
