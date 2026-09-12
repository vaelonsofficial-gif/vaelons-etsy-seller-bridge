import test from 'node:test';
import assert from 'node:assert/strict';

import { getVisionPolicy } from '../lib/control-center/vision-policy.js';

test('creative review uses the free Sezar queue without provider credentials', () => {
  const policy = getVisionPolicy({});

  assert.equal(policy.ready, false);
  assert.equal(policy.status, 'SEZAR_REVIEW_REQUIRED');
  assert.equal(policy.provider, 'ChatGPT Work');
  assert.equal(policy.credential_required, false);
  assert.equal(policy.billing_required, false);
  assert.equal(policy.external_ai_cost_usd, 0);
  assert.deepEqual(policy.blockers, ['visual_review_not_completed']);
});

test('legacy Gateway variables cannot enable automatic visual judgment', () => {
  const policy = getVisionPolicy({
    CONTROL_CENTER_VISION_ENABLED: 'true',
    CONTROL_CENTER_VISION_PROVIDER: 'vercel-ai-gateway',
    CONTROL_CENTER_VISION_MODEL: 'provider/model',
    AI_GATEWAY_API_KEY: 'unused-key'
  });

  assert.equal(policy.ready, false);
  assert.equal(policy.status, 'SEZAR_REVIEW_REQUIRED');
  assert.equal(JSON.stringify(policy).includes('unused-key'), false);
});
