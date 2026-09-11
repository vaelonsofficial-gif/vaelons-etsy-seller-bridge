function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function getVisionPolicy(env = process.env) {
  const requested = enabled(env.CONTROL_CENTER_VISION_ENABLED);
  const provider = String(env.CONTROL_CENTER_VISION_PROVIDER || '').trim() || null;
  const model = String(env.CONTROL_CENTER_VISION_MODEL || '').trim() || null;
  const credentialReady = Boolean(env.AI_GATEWAY_API_KEY);
  const blockers = [];

  if (!requested) blockers.push('vision_not_enabled');
  if (!provider) blockers.push('vision_provider_not_selected');
  if (!model) blockers.push('vision_model_not_selected');
  if (!credentialReady) blockers.push('vision_credential_not_ready');

  return {
    requested,
    ready: requested && blockers.length === 0,
    status: requested && blockers.length === 0 ? 'READY' : 'STAGED',
    provider,
    model,
    credential_ready: credentialReady,
    blockers
  };
}
