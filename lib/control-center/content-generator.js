import { createHash, randomUUID } from 'node:crypto';

import { fetchListingDetail } from './catalog.js';
import { assertContentReady, resolveContentPolicy } from './content-policy.js';
import { asListingId, snapshotFromListing, snapshotHash } from './metadata.js';
import {
  acquireListingLock,
  appendGenerationEvent,
  createGeneration,
  releaseListingLock,
  updateGeneration
} from './store.js';

const TASK_SCOPES = new Set(['FULL_LISTING', 'SEO_CONTENT', 'CREATIVE_IMAGES']);

export function normalizeContentCommand(value, maxLength = 1200) {
  const command = String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  if (command.length < 8) {
    const error = new Error('Komut en az 8 karakter olmalı');
    error.status = 400;
    error.code = 'COMMAND_TOO_SHORT';
    throw error;
  }

  if (command.length > maxLength) {
    const error = new Error(`Komut en fazla ${maxLength} karakter olabilir`);
    error.status = 400;
    error.code = 'COMMAND_TOO_LONG';
    throw error;
  }

  return command;
}

export function normalizeTaskScope(value) {
  const scope = String(value || 'FULL_LISTING').trim().toUpperCase();
  return TASK_SCOPES.has(scope) ? scope : 'FULL_LISTING';
}

export function contentCacheKey({ listingId, beforeHash, command, scope, engine }) {
  return createHash('sha256')
    .update(JSON.stringify({
      listingId: String(listingId),
      beforeHash,
      command,
      scope: normalizeTaskScope(scope),
      engine: String(engine || 'SEZAR_WORK_QUEUE')
    }))
    .digest('hex');
}

// Old Gateway failures stay readable after the free queue migration.
export function classifyGenerationError(error) {
  const providerMessage = String(error?.message || '');
  let code = error?.code || 'TASK_FAILED';
  let message = providerMessage || 'Görev kaydı tamamlanamadı. Etsy’de hiçbir değişiklik yapılmadı.';
  let status = Number(error?.status || error?.statusCode) || 500;

  if (/valid credit card|add a card|unlock your free credits/i.test(providerMessage)) {
    code = 'LEGACY_GATEWAY_REMOVED';
    status = 410;
    message = 'Bu kayıt eski ücretli AI Gateway denemesine aittir. Ücretli bağlantı kaldırıldı; görevi ücretsiz Sezar kuyruğunda yeniden oluşturabilirsiniz.';
  }

  const classified = new Error(message);
  classified.code = code;
  classified.status = status;
  return classified;
}

function generationPublic(record, cached = false) {
  return {
    id: record.id,
    listing_id: record.listing_id,
    status: record.status,
    type: record.type,
    task_scope: record.task_scope,
    engine: record.engine,
    model: record.model,
    command: record.command,
    summary: record.summary || null,
    expected_outcome: record.expected_outcome || null,
    safety_notes: record.safety_notes || [],
    proposal: record.proposal || null,
    validation: record.validation || null,
    action: record.action || null,
    estimated_cost: record.estimated_cost,
    cached,
    created_at: record.created_at,
    completed_at: record.completed_at || null,
    etsy_modified: false
  };
}

export async function queueListingContentTask({ listingId, command, scope = 'FULL_LISTING' }) {
  const policy = await resolveContentPolicy();
  assertContentReady(policy);
  const normalizedCommand = normalizeContentCommand(command, policy.max_command_characters);
  const taskScope = normalizeTaskScope(scope);
  const id = asListingId(listingId);
  const taskId = randomUUID();
  const lockOwner = `task:${taskId}`;

  await acquireListingLock(id, lockOwner);

  let persisted = null;
  let ownsTask = false;
  try {
    const listing = await fetchListingDetail(id);
    const before = snapshotFromListing(listing);
    const beforeHash = snapshotHash(before);
    const now = new Date().toISOString();
    const task = {
      schema_version: 2,
      id: taskId,
      cache_key: contentCacheKey({
        listingId: listing.listing_id,
        beforeHash,
        command: normalizedCommand,
        scope: taskScope,
        engine: policy.engine
      }),
      listing_id: Number(listing.listing_id),
      shop_id: Number(listing.shop_identity.shop_id),
      type: 'LISTING_IMPROVEMENT_TASK',
      status: 'QUEUED',
      task_scope: taskScope,
      engine: policy.engine,
      model: policy.model,
      provider: policy.provider,
      command: normalizedCommand,
      before,
      before_hash: beforeHash,
      estimated_cost: {
        currency: 'USD',
        amount: 0,
        estimated: false,
        reason: 'no_external_ai_api'
      },
      etsy_modified: false,
      created_at: now,
      updated_at: now
    };

    const reservation = await createGeneration(task);
    persisted = reservation.generation;
    ownsTask = reservation.created;

    if (!reservation.created) return generationPublic(persisted, true);

    await appendGenerationEvent(taskId, {
      type: 'TASK_QUEUED_FOR_SEZAR',
      status: 'QUEUED',
      task_scope: taskScope,
      external_ai_cost_usd: 0,
      etsy_modified: false
    });

    return generationPublic(task, false);
  } catch (error) {
    const classified = classifyGenerationError(error);
    if (ownsTask && persisted?.id) {
      classified.generationId = persisted.id;
      try {
        await updateGeneration(persisted.id, {
          status: 'FAILED',
          error: { code: classified.code, message: classified.message },
          failed_at: new Date().toISOString()
        });
        await appendGenerationEvent(persisted.id, {
          type: 'TASK_QUEUE_FAILED',
          status: 'FAILED',
          code: classified.code,
          etsy_modified: false
        });
      } catch {
        // Preserve the original queue failure.
      }
    }
    throw classified;
  } finally {
    try {
      await releaseListingLock(id, lockOwner);
    } catch {
      // Lock expiration is the final fail-safe.
    }
  }
}
