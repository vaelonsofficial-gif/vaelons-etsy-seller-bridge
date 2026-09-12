function disabled(value) {
  return ['0', 'false', 'off', 'disabled'].includes(String(value || '').trim().toLowerCase());
}

export function getContentPolicy(env = process.env) {
  const explicitlyDisabled = disabled(env.CONTROL_CENTER_FREE_QUEUE_ENABLED);
  const blockers = explicitlyDisabled ? ['free_queue_disabled'] : [];

  return {
    provider: 'ChatGPT Work',
    model: 'Sezar editorial workflow',
    engine: 'SEZAR_WORK_QUEUE',
    ready: blockers.length === 0,
    status: blockers.length === 0 ? 'FREE_QUEUE_READY' : 'BLOCKED',
    auth_source: 'NO_EXTERNAL_AI_API',
    billing_required: false,
    external_ai_cost_usd: 0,
    max_command_characters: 1200,
    blockers
  };
}

export function assertContentReady(policy) {
  if (policy?.ready) return;
  const error = new Error('Ücretsiz Sezar iş kuyruğu şu anda kapalı');
  error.status = 503;
  error.code = 'FREE_QUEUE_NOT_READY';
  error.details = policy?.blockers || [];
  throw error;
}

export async function resolveContentPolicy(env = process.env) {
  return getContentPolicy(env);
}
