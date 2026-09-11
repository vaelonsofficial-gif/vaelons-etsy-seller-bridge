import { getTokenStatus, getVerifiedShopIdentity } from '../../src/etsy.js';
import { getPersistenceHealth } from './store.js';
import { getWritePolicy } from './write-policy.js';
import { getVisionPolicy } from './vision-policy.js';

function settled(result) {
  if (result.status === 'fulfilled') return { ok: true, value: result.value };
  return {
    ok: false,
    error: result.reason?.message || String(result.reason || 'unknown_error')
  };
}

export async function getSystemHealth() {
  const startedAt = Date.now();
  const [token, identity, persistence] = await Promise.allSettled([
    getTokenStatus(),
    getVerifiedShopIdentity(),
    getPersistenceHealth()
  ]);
  const policy = getWritePolicy();
  const visionPolicy = getVisionPolicy();
  const tokenState = settled(token);
  const identityState = settled(identity);
  const persistenceState = settled(persistence);

  return {
    ok:
      tokenState.ok &&
      Boolean(tokenState.value?.connected) &&
      identityState.ok &&
      Boolean(identityState.value?.verified) &&
      persistenceState.ok &&
      Boolean(persistenceState.value?.healthy),
    version: '0.4.0',
    mode: policy.mode,
    write_policy: policy,
    checks: {
      etsy_token: tokenState,
      shop_identity: identityState,
      persistence: persistenceState
    },
    vision_policy: visionPolicy,
    duration_ms: Date.now() - startedAt,
    checked_at: new Date().toISOString()
  };
}
