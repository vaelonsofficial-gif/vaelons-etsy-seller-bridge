import { getVercelOidcToken } from '@vercel/oidc';

const DEFAULT_MODEL = 'openai/gpt-5.6-sol';

function disabled(value) {
  return ['0', 'false', 'off', 'disabled'].includes(String(value || '').trim().toLowerCase());
}

export function getContentPolicy(env = process.env) {
  const model = String(env.CONTROL_CENTER_CONTENT_MODEL || DEFAULT_MODEL).trim();
  const explicitlyDisabled = disabled(env.CONTROL_CENTER_CONTENT_AI_ENABLED);
  const gatewayAuth = Boolean(env.AI_GATEWAY_API_KEY || env.VERCEL_OIDC_TOKEN);
  const blockers = [];

  if (explicitlyDisabled) blockers.push('content_ai_disabled');
  if (!gatewayAuth) blockers.push('ai_gateway_auth_missing');

  return {
    provider: 'Vercel AI Gateway',
    model,
    ready: blockers.length === 0,
    status: blockers.length === 0 ? 'READY' : 'BLOCKED',
    auth_source: env.AI_GATEWAY_API_KEY
      ? 'AI_GATEWAY_API_KEY'
      : env.VERCEL_OIDC_TOKEN
        ? 'VERCEL_OIDC_TOKEN'
        : null,
    max_command_characters: 1200,
    blockers
  };
}

export function assertContentReady(policy) {
  if (policy?.ready) return;
  const error = new Error('İçerik motoru henüz AI Gateway bağlantısına hazır değil');
  error.status = 503;
  error.code = 'CONTENT_AI_NOT_READY';
  error.details = policy?.blockers || [];
  throw error;
}

export async function resolveContentPolicy(
  env = process.env,
  { getOidcToken = getVercelOidcToken } = {}
) {
  const policy = getContentPolicy(env);
  if (policy.ready || policy.blockers.includes('content_ai_disabled')) return policy;

  try {
    const token = await getOidcToken();
    if (!token) return policy;
    return {
      ...policy,
      ready: true,
      status: 'READY',
      auth_source: 'REQUEST_OIDC',
      blockers: policy.blockers.filter((blocker) => blocker !== 'ai_gateway_auth_missing')
    };
  } catch {
    return policy;
  }
}
