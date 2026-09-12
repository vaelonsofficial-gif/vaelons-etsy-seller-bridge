import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { fetchListingDetail } from './catalog.js';
import { assertContentReady, resolveContentPolicy } from './content-policy.js';
import { prepareMetadataAction } from './actions.js';
import {
  asListingId,
  snapshotFromListing,
  snapshotHash,
  validateMetadataProposal
} from './metadata.js';
import {
  acquireListingLock,
  appendGenerationEvent,
  createGeneration,
  getGeneration,
  listGenerations,
  releaseListingLock,
  updateGeneration
} from './store.js';

const TASK_SCOPES = new Set(['FULL_LISTING', 'SEO_CONTENT', 'CREATIVE_IMAGES']);
const AUTOMATION_CLAIM_TTL_MS = 55 * 60 * 1000;
const AUTOMATION_PAYLOAD_MAX_BYTES = 7_000;
const AUTOMATION_DESCRIPTION_MAX_CHARACTERS = 4_000;

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

function cleanSummary(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 500);
}

export function automationClaimHash(taskId, token) {
  return createHash('sha256')
    .update(`${String(taskId)}:${String(token)}`)
    .digest('hex');
}

export function isAutomationClaimExpired(task, now = Date.now()) {
  const expiresAt = Date.parse(task?.automation_claim_expires_at || '');
  return !Number.isFinite(expiresAt) || expiresAt <= Number(now);
}

export function isRecoverableNoChangeCompletion(task) {
  const warnings = Array.isArray(task?.validation?.warnings)
    ? task.validation.warnings
    : [];
  const changedFields = Array.isArray(task?.validation?.changed_fields)
    ? task.validation.changed_fields
    : [];

  return task?.status === 'COMPLETED' &&
    task?.etsy_modified !== true &&
    !task?.action_id &&
    !task?.action &&
    warnings.includes('no_changes') &&
    changedFields.length === 0;
}

export function isRetryableMetadataChangeBlock(task) {
  const errors = Array.isArray(task?.validation?.errors)
    ? task.validation.errors
    : [];
  const changedFields = Array.isArray(task?.validation?.changed_fields)
    ? task.validation.changed_fields
    : [];
  const hasStoredRetryCount = task?.metadata_change_retry_count !== undefined &&
    task?.metadata_change_retry_count !== null;
  const storedRetryCount = Number(task?.metadata_change_retry_count);
  const retryCount = hasStoredRetryCount && Number.isInteger(storedRetryCount) && storedRetryCount >= 0
    ? storedRetryCount
    : 1;

  return task?.status === 'BLOCKED' &&
    task?.etsy_modified !== true &&
    !task?.action_id &&
    !task?.action &&
    errors.includes('metadata_change_required') &&
    changedFields.length === 0 &&
    retryCount === 1;
}

export function completedSubmissionMatches(task, input) {
  if (task?.status !== 'COMPLETED' || task?.action?.status !== 'VALIDATED') return false;
  const persisted = task.proposal || task.action?.proposed;
  if (!persisted) return false;

  return validateMetadataProposal(persisted, input).changed_fields.length === 0;
}

export function requireTaskMetadataChange(validation, noChanges) {
  if (!noChanges) return validation;

  return {
    ...validation,
    valid: false,
    errors: [...new Set([...(validation?.errors || []), 'metadata_change_required'])],
    warnings: [...new Set(validation?.warnings || [])],
    qa: {
      ...(validation?.qa || {}),
      passed: false,
      etsy_modified: false
    }
  };
}

export function selectNextAutomationTask(tasks, now = Date.now()) {
  return [...(Array.isArray(tasks) ? tasks : [])]
    .filter((task) => task?.task_scope !== 'CREATIVE_IMAGES')
    .filter((task) => task?.status === 'QUEUED' || (
      task?.status === 'IN_PROGRESS' && isAutomationClaimExpired(task, now)
    ) || isRecoverableNoChangeCompletion(task) || isRetryableMetadataChangeBlock(task))
    .sort((left, right) => Date.parse(left.created_at || 0) - Date.parse(right.created_at || 0))[0] || null;
}

export function normalizeAutomationPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const error = new Error('Otomasyon sonucu geçerli bir nesne olmalı');
    error.status = 400;
    error.code = 'AUTOMATION_PAYLOAD_INVALID';
    throw error;
  }

  const payload = {
    title: String(value.title || ''),
    tags: Array.isArray(value.tags) ? value.tags.map((tag) => String(tag || '')) : [],
    description: String(value.description || ''),
    summary: cleanSummary(value.summary)
  };

  if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > AUTOMATION_PAYLOAD_MAX_BYTES) {
    const error = new Error('Otomasyon sonucu güvenli aktarım sınırını aşıyor');
    error.status = 413;
    error.code = 'AUTOMATION_PAYLOAD_TOO_LARGE';
    throw error;
  }

  if (payload.description.length > AUTOMATION_DESCRIPTION_MAX_CHARACTERS) {
    const error = new Error(`Arka plan açıklaması en fazla ${AUTOMATION_DESCRIPTION_MAX_CHARACTERS} karakter olabilir`);
    error.status = 413;
    error.code = 'AUTOMATION_DESCRIPTION_TOO_LONG';
    throw error;
  }

  return payload;
}

function taskContext(listing) {
  return {
    listing_url: listing.url || null,
    taxonomy_id: listing.taxonomy_id || null,
    price: listing.price || null,
    hero_url: listing.hero_url || null,
    images: Array.isArray(listing.images)
      ? listing.images.slice(0, 10).map((image) => ({
        rank: image.rank,
        alt_text: image.alt_text,
        url: image.url_fullxfull || image.url_570xN || null,
        width: image.width,
        height: image.height
      }))
      : []
  };
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

export function generationPublic(record, cached = false) {
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
    automation_claimed_at: record.automation_claimed_at || null,
    automation_claim_expires_at: record.automation_claim_expires_at || null,
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
      context: taskContext(listing),
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

export async function claimNextListingContentTask() {
  const candidate = selectNextAutomationTask(await listGenerations(100));
  if (!candidate) return null;

  const lockOwner = `automation-claim:${candidate.id}:${randomUUID()}`;
  await acquireListingLock(candidate.listing_id, lockOwner);

  try {
    const current = await getGeneration(candidate.id);
    const eligible = current?.status === 'QUEUED' || (
      current?.status === 'IN_PROGRESS' && isAutomationClaimExpired(current)
    ) || isRecoverableNoChangeCompletion(current);
    if (!eligible || current?.task_scope === 'CREATIVE_IMAGES') return null;

    const claimToken = randomBytes(32).toString('base64url');
    const claimedAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + AUTOMATION_CLAIM_TTL_MS).toISOString();
    const updated = await updateGeneration(current.id, {
      status: 'IN_PROGRESS',
      automation_claim_hash: automationClaimHash(current.id, claimToken),
      automation_claimed_at: claimedAt,
      automation_claim_expires_at: expiresAt,
      automation_attempt: Number(current.automation_attempt || 0) + 1,
      etsy_modified: false
    });

    await appendGenerationEvent(current.id, {
      type: 'BACKGROUND_TASK_CLAIMED',
      status: 'IN_PROGRESS',
      claim_expires_at: expiresAt,
      etsy_modified: false
    });

    return {
      id: updated.id,
      listing_id: updated.listing_id,
      task_scope: updated.task_scope,
      command: updated.command,
      before: updated.before,
      before_hash: updated.before_hash,
      context: updated.context || null,
      claim_token: claimToken,
      claim_expires_at: expiresAt,
      constraints: {
        language: 'English',
        title_max_characters: 140,
        tags_exact_count: 13,
        tag_max_characters: 20,
        description_max_characters: AUTOMATION_DESCRIPTION_MAX_CHARACTERS,
        unsupported_product_claims_forbidden: true,
        etsy_publish_forbidden: true
      }
    };
  } finally {
    try {
      await releaseListingLock(candidate.listing_id, lockOwner);
    } catch {
      // The lock expires automatically.
    }
  }
}

export async function completeListingContentTask({ taskId, title, tags, description, summary }) {
  const task = await getGeneration(String(taskId || ''));

  if (!task) {
    const error = new Error('Sezar görev kaydı bulunamadı');
    error.status = 404;
    error.code = 'TASK_NOT_FOUND';
    throw error;
  }

  const submission = { title, tags, description };
  if (completedSubmissionMatches(task, submission)) {
    return {
      task,
      result: {
        created: false,
        no_changes: false,
        action: task.action,
        validation: task.validation,
        etsy_modified: false
      },
      valid: true,
      cached: true
    };
  }

  if (!['QUEUED', 'BLOCKED', 'IN_PROGRESS'].includes(task.status) && !isRecoverableNoChangeCompletion(task)) {
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

  const prepared = await prepareMetadataAction({
    listingId: task.listing_id,
    title,
    tags,
    description,
    reason: `sezar_queue:${task.id}`,
    expectedBeforeHash: task.before_hash,
    strictClaims: true,
    source: 'SEZAR_REVIEW',
    generationId: task.id
  });

  const completedAt = new Date().toISOString();
  const validation = requireTaskMetadataChange(prepared.validation, prepared.no_changes);
  const result = { ...prepared, validation };
  const valid = !result.no_changes && validation.valid;
  const hasStoredMetadataRetryCount = task.metadata_change_retry_count !== undefined &&
    task.metadata_change_retry_count !== null;
  const previousMetadataRetryCount = hasStoredMetadataRetryCount && Number.isInteger(Number(task.metadata_change_retry_count))
    ? Number(task.metadata_change_retry_count)
    : (isRetryableMetadataChangeBlock(task) ? 1 : 0);
  const updated = await updateGeneration(task.id, {
    status: valid ? 'COMPLETED' : 'BLOCKED',
    summary: result.no_changes
      ? 'Hazırlanan alanlar mevcut içerikle aynı kaldı; görev yeniden düzenlemeye açık.'
      : cleanSummary(summary) || (
        valid
          ? 'Sezar tarafından hazırlanan içerik doğrulandı.'
          : 'Hazırlanan içerik güvenlik doğrulamasından geçmedi.'),
    expected_outcome: result.no_changes
      ? 'Başlık, etiket veya açıklamadan en az biri gerçek bir iyileştirmeyle değiştirilmelidir.'
      : 'Onay verilirse yalnızca gösterilen metadata alanları Etsy’ye uygulanacak.',
    safety_notes: valid
      ? validation.warnings || []
      : [...new Set([...(validation.errors || []), ...(validation.warnings || [])])],
    proposal: validation.proposed,
    validation,
    action_id: result.action?.id || null,
    action: result.action,
    metadata_change_retry_count: result.no_changes
      ? previousMetadataRetryCount + 1
      : previousMetadataRetryCount,
    completed_at: valid ? completedAt : null,
    automation_completed_at: task.status === 'IN_PROGRESS' && valid ? completedAt : null,
    etsy_modified: false
  });

  await appendGenerationEvent(task.id, {
    type: valid ? 'SEZAR_CONTENT_VALIDATED' : 'SEZAR_CONTENT_BLOCKED',
    status: updated.status,
    action_id: result.action?.id || null,
    reason: result.no_changes ? 'metadata_change_required' : undefined,
    external_ai_cost_usd: 0,
    etsy_modified: false
  });

  return { task: updated, result, valid, cached: false };
}

export async function completeClaimedListingContentTask({ taskId, claimToken, payload }) {
  const task = await getGeneration(String(taskId || ''));
  if (!task) {
    const error = new Error('Arka plan görev kaydı bulunamadı');
    error.status = 404;
    error.code = 'TASK_NOT_FOUND';
    throw error;
  }

  const expected = String(task.automation_claim_hash || '');
  const actual = automationClaimHash(task.id, claimToken);
  const matches = expected.length === actual.length && timingSafeEqual(Buffer.from(expected), Buffer.from(actual));

  if (task.status === 'COMPLETED' && task.automation_completed_at && matches && !isAutomationClaimExpired(task)) {
    return { task, result: { action: task.action || null, validation: task.validation }, valid: true, cached: true };
  }

  if (task.status !== 'IN_PROGRESS' || !matches || isAutomationClaimExpired(task)) {
    const error = new Error('Arka plan görev bileti geçersiz veya süresi dolmuş');
    error.status = 401;
    error.code = 'AUTOMATION_CLAIM_INVALID';
    throw error;
  }

  const normalized = normalizeAutomationPayload(payload);
  return completeListingContentTask({ taskId: task.id, ...normalized });
}
