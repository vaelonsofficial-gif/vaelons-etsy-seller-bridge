import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertContentReady,
  getContentPolicy,
  resolveContentPolicy
} from '../lib/control-center/content-policy.js';

test('content policy fails closed without Gateway authentication', () => {
  const policy = getContentPolicy({});
  assert.equal(policy.ready, false);
  assert.ok(policy.blockers.includes('ai_gateway_auth_missing'));
  assert.throws(() => assertContentReady(policy), (error) => error.code === 'CONTENT_AI_NOT_READY');
});

test('Vercel OIDC makes content preparation ready without exposing a secret', () => {
  const policy = getContentPolicy({ VERCEL_OIDC_TOKEN: 'test-token' });
  assert.equal(policy.ready, true);
  assert.equal(policy.auth_source, 'VERCEL_OIDC_TOKEN');
  assert.equal(JSON.stringify(policy).includes('test-token'), false);
});

test('explicit content kill switch wins over valid authentication', () => {
  const policy = getContentPolicy({
    AI_GATEWAY_API_KEY: 'test-key',
    CONTROL_CENTER_CONTENT_AI_ENABLED: 'off'
  });
  assert.equal(policy.ready, false);
  assert.ok(policy.blockers.includes('content_ai_disabled'));
});

test('request-scoped Vercel OIDC is resolved without exposing the token', async () => {
  const policy = await resolveContentPolicy(
    {},
    { getOidcToken: async () => 'request-token' }
  );
  assert.equal(policy.ready, true);
  assert.equal(policy.auth_source, 'REQUEST_OIDC');
  assert.equal(JSON.stringify(policy).includes('request-token'), false);
});

test('request OIDC cannot override the content kill switch', async () => {
  let called = false;
  const policy = await resolveContentPolicy(
    { CONTROL_CENTER_CONTENT_AI_ENABLED: 'off' },
    { getOidcToken: async () => { called = true; return 'request-token'; } }
  );
  assert.equal(policy.ready, false);
  assert.equal(called, false);
});
