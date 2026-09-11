import test from 'node:test';
import assert from 'node:assert/strict';

import { assertWriteAllowed, getWritePolicy } from '../lib/control-center/write-policy.js';

test('write policy is locked by default', () => {
  const policy = getWritePolicy({});
  assert.equal(policy.mode, 'READ_ONLY');
  assert.equal(policy.write_locked, true);
  assert.equal(policy.can_execute, false);
});

test('SAFE_WRITE requires every independent safety gate', () => {
  const policy = getWritePolicy({ CONTROL_CENTER_WRITE_MODE: 'SAFE_WRITE' });
  assert.equal(policy.write_locked, true);
  assert.ok(policy.blockers.includes('global_kill_switch_active'));
  assert.ok(policy.blockers.includes('control_center_auth_not_ready'));
  assert.ok(policy.blockers.includes('safe_listing_not_selected'));
});

test('exact allowlisted listing can pass a fully configured SAFE_WRITE policy', () => {
  const policy = getWritePolicy({
    CONTROL_CENTER_WRITE_MODE: 'SAFE_WRITE',
    CONTROL_CENTER_KILL_SWITCH: 'OFF',
    CONTROL_CENTER_AUTH_READY: 'true',
    CONTROL_CENTER_SAFE_LISTING_ID: '4554465743'
  });

  assert.equal(policy.can_execute, true);
  assert.doesNotThrow(() => assertWriteAllowed(policy, '4554465743'));
  assert.throws(
    () => assertWriteAllowed(policy, '123'),
    (error) => error.code === 'LISTING_NOT_ALLOWLISTED'
  );
});

test('AUTOPILOT cannot be enabled by environment variables alone', () => {
  const policy = getWritePolicy({
    CONTROL_CENTER_WRITE_MODE: 'AUTOPILOT',
    CONTROL_CENTER_KILL_SWITCH: 'OFF',
    CONTROL_CENTER_AUTH_READY: 'true',
    CONTROL_CENTER_SAFE_LISTING_ID: '4554465743'
  });

  assert.equal(policy.write_locked, true);
  assert.ok(policy.blockers.includes('autopilot_not_promoted'));
});
