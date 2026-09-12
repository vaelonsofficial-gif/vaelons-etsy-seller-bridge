import { Redis } from '@upstash/redis';

const PREFIX = 'vaelons:control-center:v1';
const ACTION_TTL_SECONDS = 14 * 24 * 60 * 60;
const ACTION_INDEX_LIMIT = 500;
const LOCK_TTL_SECONDS = 90;
const GENERATION_CACHE_TTL_SECONDS = 24 * 60 * 60;

let redisClient = null;

function config() {
  const url =
    process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN;

  return { url, token, configured: Boolean(url && token) };
}

function redis() {
  if (redisClient) return redisClient;
  const state = config();

  if (!state.configured) {
    const error = new Error('Control Center kalıcı kayıt deposu yapılandırılmamış');
    error.status = 503;
    error.code = 'PERSISTENCE_UNAVAILABLE';
    throw error;
  }

  redisClient = new Redis({ url: state.url, token: state.token, enableTelemetry: false });
  return redisClient;
}

function actionKey(actionId) {
  return `${PREFIX}:action:${actionId}`;
}

function eventKey(actionId) {
  return `${PREFIX}:events:${actionId}`;
}

function idempotencyKey(key) {
  return `${PREFIX}:idempotency:${key}`;
}

function listingLockKey(listingId) {
  return `${PREFIX}:lock:listing:${listingId}`;
}

function generationKey(generationId) {
  return `${PREFIX}:generation:${generationId}`;
}

function generationEventKey(generationId) {
  return `${PREFIX}:generation-events:${generationId}`;
}

function generationCacheKey(cacheKey) {
  return `${PREFIX}:generation-cache:${cacheKey}`;
}

function decode(value) {
  if (value == null || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function getPersistenceConfig() {
  return { configured: config().configured };
}

export async function getPersistenceHealth() {
  const state = config();
  if (!state.configured) return { configured: false, healthy: false, reason: 'missing_environment' };

  try {
    const response = await redis().ping();
    return { configured: true, healthy: String(response).toUpperCase() === 'PONG' };
  } catch (error) {
    return { configured: true, healthy: false, reason: error?.message || 'redis_ping_failed' };
  }
}

export async function getAction(actionId) {
  return decode(await redis().get(actionKey(actionId)));
}

export async function createAction(action) {
  const reservation = await redis().set(
    idempotencyKey(action.idempotency_key),
    action.id,
    { nx: true, ex: ACTION_TTL_SECONDS }
  );

  if (reservation === null) {
    const existingId = await redis().get(idempotencyKey(action.idempotency_key));
    const existing = existingId ? await getAction(existingId) : null;
    if (existing) return { action: existing, created: false };

    const error = new Error('Aynı değişiklik taslağı için başka bir kayıt işlemi devam ediyor');
    error.status = 409;
    error.code = 'IDEMPOTENCY_CONFLICT';
    throw error;
  }

  await Promise.all([
    redis().set(actionKey(action.id), JSON.stringify(action), { ex: ACTION_TTL_SECONDS }),
    redis().lpush(`${PREFIX}:action-index`, action.id),
    redis().ltrim(`${PREFIX}:action-index`, 0, ACTION_INDEX_LIMIT - 1),
    appendActionEvent(action.id, {
      type: 'ACTION_CREATED',
      status: action.status,
      etsy_modified: false
    })
  ]);

  return { action, created: true };
}

export async function updateAction(actionId, patch) {
  const current = await getAction(actionId);
  if (!current) {
    const error = new Error('İşlem kaydı bulunamadı veya süresi doldu');
    error.status = 404;
    error.code = 'ACTION_NOT_FOUND';
    throw error;
  }

  const updated = { ...current, ...patch, updated_at: new Date().toISOString() };
  await redis().set(actionKey(actionId), JSON.stringify(updated), { ex: ACTION_TTL_SECONDS });
  return updated;
}

export async function appendActionEvent(actionId, event) {
  const payload = { ...event, recorded_at: new Date().toISOString() };
  await redis().lpush(eventKey(actionId), JSON.stringify(payload));
  await redis().ltrim(eventKey(actionId), 0, 99);
  await redis().expire(eventKey(actionId), ACTION_TTL_SECONDS);
  return payload;
}

export async function getActionEvents(actionId) {
  const rows = await redis().lrange(eventKey(actionId), 0, 99);
  return rows.map(decode).filter(Boolean);
}

export async function listActions(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const ids = await redis().lrange(`${PREFIX}:action-index`, 0, safeLimit - 1);
  const uniqueIds = [...new Set(ids.map(String))];
  const actions = await Promise.all(uniqueIds.map((id) => getAction(id)));
  return actions.filter(Boolean);
}

export async function getGeneration(generationId) {
  return decode(await redis().get(generationKey(generationId)));
}

export async function createGeneration(generation) {
  const cacheKey = generationCacheKey(generation.cache_key);
  let reservation = await redis().set(
    cacheKey,
    generation.id,
    { nx: true, ex: GENERATION_CACHE_TTL_SECONDS }
  );

  if (reservation === null) {
    const existingId = await redis().get(cacheKey);
    const existing = existingId ? await getGeneration(existingId) : null;

    if (existing && ['PENDING', 'QUEUED', 'IN_PROGRESS', 'COMPLETED'].includes(existing.status)) {
      return { generation: existing, created: false };
    }

    // A failed or orphaned attempt must never permanently block a safe retry.
    reservation = await redis().set(
      cacheKey,
      generation.id,
      { xx: true, ex: GENERATION_CACHE_TTL_SECONDS }
    );
  }

  if (reservation === null) {
    const error = new Error('İçerik üretimi için güvenli kayıt ayrılamadı');
    error.status = 409;
    error.code = 'GENERATION_RESERVATION_FAILED';
    throw error;
  }

  await Promise.all([
    redis().set(generationKey(generation.id), JSON.stringify(generation)),
    redis().lpush(`${PREFIX}:generation-index`, generation.id),
    appendGenerationEvent(generation.id, {
      type: 'GENERATION_CREATED',
      status: generation.status,
      etsy_modified: false
    })
  ]);

  return { generation, created: true };
}

export async function updateGeneration(generationId, patch) {
  const current = await getGeneration(generationId);
  if (!current) {
    const error = new Error('İçerik üretim kaydı bulunamadı');
    error.status = 404;
    error.code = 'GENERATION_NOT_FOUND';
    throw error;
  }

  const updated = { ...current, ...patch, updated_at: new Date().toISOString() };
  await redis().set(generationKey(generationId), JSON.stringify(updated));
  return updated;
}

export async function appendGenerationEvent(generationId, event) {
  const payload = { ...event, recorded_at: new Date().toISOString() };
  await redis().lpush(generationEventKey(generationId), JSON.stringify(payload));
  return payload;
}

export async function getGenerationEvents(generationId) {
  const rows = await redis().lrange(generationEventKey(generationId), 0, 99);
  return rows.map(decode).filter(Boolean);
}

export async function listGenerations(limit = 50) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const ids = await redis().lrange(`${PREFIX}:generation-index`, 0, safeLimit - 1);
  const uniqueIds = [...new Set(ids.map(String))];
  const generations = await Promise.all(uniqueIds.map((id) => getGeneration(id)));
  return generations.filter(Boolean);
}

export async function acquireListingLock(listingId, ownerToken) {
  const result = await redis().set(
    listingLockKey(listingId),
    ownerToken,
    { nx: true, ex: LOCK_TTL_SECONDS }
  );

  if (result === null) {
    const error = new Error('Bu listing için başka bir işlem devam ediyor');
    error.status = 423;
    error.code = 'LISTING_LOCKED';
    throw error;
  }
}

export async function releaseListingLock(listingId, ownerToken) {
  const key = listingLockKey(listingId);
  const currentOwner = await redis().get(key);
  if (String(currentOwner || '') === String(ownerToken)) await redis().del(key);
}
