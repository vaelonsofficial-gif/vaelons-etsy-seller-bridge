import test from 'node:test';
import assert from 'node:assert/strict';

import { getVisionPolicy } from '../lib/control-center/vision-policy.js';

test('vision policy is staged and fail-closed by default', () => {
  const policy = getVisionPolicy({});

  assert.equal(policy.ready, false);
  assert.equal(policy.status, 'STAGED');
  assert.ok(policy.blockers.includes('vision_not_enabled'));
  assert.ok(policy.blockers.includes('vision_credential_not_ready'));
});

test('vision only becomes ready with explicit enablement, provider, model and credential', () => {
  const policy = getVisionPolicy({
    CONTROL_CENTER_VISION_ENABLED: 'true',
    CONTROL_CENTER_VISION_PROVIDER: 'vercel-ai-gateway',
    CONTROL_CENTER_VISION_MODEL: 'provider/model',
    AI_GATEWAY_API_KEY: 'test-only-key'
  });

  assert.equal(policy.ready, true);
  assert.equal(policy.status, 'READY');
  assert.deepEqual(policy.blockers, []);
});

test('missing credential keeps an otherwise configured policy staged', () => {
  const policy = getVisionPolicy({
    CONTROL_CENTER_VISION_ENABLED: 'true',
    CONTROL_CENTER_VISION_PROVIDER: 'vercel-ai-gateway',
    CONTROL_CENTER_VISION_MODEL: 'provider/model'
  });

  assert.equal(policy.ready, false);
  assert.ok(policy.blockers.includes('vision_credential_not_ready'));
});
