import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertContentReady,
  getContentPolicy,
  resolveContentPolicy
} from '../lib/control-center/content-policy.js';

test('free Sezar queue is ready without Gateway credentials', () => {
  const policy = getContentPolicy({});
  assert.equal(policy.ready, true);
  assert.equal(policy.status, 'FREE_QUEUE_READY');
  assert.equal(policy.auth_source, 'NO_EXTERNAL_AI_API');
  assert.equal(policy.billing_required, false);
  assert.equal(policy.external_ai_cost_usd, 0);
  assert.doesNotThrow(() => assertContentReady(policy));
});

test('old Gateway credentials do not change the free operating model', () => {
  const policy = getContentPolicy({
    AI_GATEWAY_API_KEY: 'unused-key',
    VERCEL_OIDC_TOKEN: 'unused-token'
  });
  assert.equal(policy.ready, true);
  assert.equal(policy.provider, 'ChatGPT Work');
  assert.equal(JSON.stringify(policy).includes('unused-key'), false);
  assert.equal(JSON.stringify(policy).includes('unused-token'), false);
});

test('explicit free queue kill switch fails closed', () => {
  const policy = getContentPolicy({ CONTROL_CENTER_FREE_QUEUE_ENABLED: 'off' });
  assert.equal(policy.ready, false);
  assert.ok(policy.blockers.includes('free_queue_disabled'));
  assert.throws(() => assertContentReady(policy), (error) => error.code === 'FREE_QUEUE_NOT_READY');
});

test('resolved content policy never performs external authentication', async () => {
  const policy = await resolveContentPolicy({});
  assert.equal(policy.ready, true);
  assert.equal(policy.engine, 'SEZAR_WORK_QUEUE');
});
