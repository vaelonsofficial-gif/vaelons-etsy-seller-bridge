const VALID_MODES = new Set(['READ_ONLY', 'SAFE_WRITE', 'AUTOPILOT']);

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function getWritePolicy(env = process.env) {
  const requestedMode = String(env.CONTROL_CENTER_WRITE_MODE || 'READ_ONLY').trim().toUpperCase();
  const mode = VALID_MODES.has(requestedMode) ? requestedMode : 'READ_ONLY';
  const killSwitchActive = !['off', '0', 'false'].includes(
    String(env.CONTROL_CENTER_KILL_SWITCH || 'ON').trim().toLowerCase()
  );
  const authenticationReady = enabled(env.CONTROL_CENTER_AUTH_READY);
  const allowedListingId = /^\d+$/.test(String(env.CONTROL_CENTER_SAFE_LISTING_ID || '').trim())
    ? String(env.CONTROL_CENTER_SAFE_LISTING_ID).trim()
    : null;

  const blockers = [];
  if (mode === 'READ_ONLY') blockers.push('write_mode_read_only');
  if (killSwitchActive) blockers.push('global_kill_switch_active');
  if (!authenticationReady) blockers.push('control_center_auth_not_ready');
  if (mode === 'SAFE_WRITE' && !allowedListingId) blockers.push('safe_listing_not_selected');
  if (mode === 'AUTOPILOT') blockers.push('autopilot_not_promoted');

  return {
    mode,
    write_locked: blockers.length > 0,
    can_prepare: true,
    can_execute: blockers.length === 0 && mode === 'SAFE_WRITE',
    can_rollback: blockers.length === 0 && mode === 'SAFE_WRITE',
    kill_switch_active: killSwitchActive,
    authentication_ready: authenticationReady,
    allowed_listing_id: allowedListingId,
    blockers
  };
}

export function assertWriteAllowed(policy, listingId) {
  const id = String(listingId);

  if (!policy?.can_execute) {
    const error = new Error('Global Etsy yazma kilidi aktif');
    error.status = 423;
    error.code = 'WRITE_LOCKED';
    error.details = policy?.blockers || [];
    throw error;
  }

  if (policy.mode !== 'SAFE_WRITE' || policy.allowed_listing_id !== id) {
    const error = new Error('Bu listing SAFE_WRITE testi için yetkilendirilmedi');
    error.status = 403;
    error.code = 'LISTING_NOT_ALLOWLISTED';
    throw error;
  }
}
