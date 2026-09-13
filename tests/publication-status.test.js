import test from 'node:test';
import assert from 'node:assert/strict';
import { getWritePolicy, assertWriteAllowed } from '../lib/control-center/write-policy.js';
import { publicationStatus } from '../lib/control-center/publication-status.js';

const readyEnv = { CONTROL_CENTER_WRITE_MODE: 'SAFE_WRITE', CONTROL_CENTER_KILL_SWITCH: 'OFF',
  CONTROL_CENTER_AUTH_READY: 'true', CONTROL_CENTER_SAFE_LISTING_ID: '123' };

test('displayed publication availability agrees with the server for every safety gate and listing', () => {
  const environments = [{}, readyEnv, ...Object.keys(readyEnv).map((key) => {
    const env = { ...readyEnv };
    delete env[key];
    return env;
  }), { ...readyEnv, CONTROL_CENTER_WRITE_MODE: 'AUTOPILOT' }];
  for (const env of environments) {
    const policy = getWritePolicy(env);
    for (const listingId of ['123', '456']) {
      const displayed = publicationStatus(policy, listingId);
      let serverAllows = true;
      try { assertWriteAllowed(policy, listingId); } catch { serverAllows = false; }
      assert.equal(displayed.canPublish, serverAllows);
      if (!serverAllows) assert.ok(displayed.reasons.length > 0);
    }
  }
});

test('missing policy and another allowed listing show an actionable explanation', () => {
  assert.equal(publicationStatus(null).canPublish, false);
  assert.match(publicationStatus(null).summary, /doğrulanamıyor/);
  assert.match(publicationStatus(getWritePolicy(readyEnv), '456').summary, /yalnızca #123/);
  const locked = publicationStatus(getWritePolicy({}));
  assert.ok(locked.reasons.some((reason) => reason.includes('hazırlama ve inceleme')));
  assert.ok(locked.reasons.some((reason) => reason.includes('yayın erişimi henüz doğrulanmamış')));
});
