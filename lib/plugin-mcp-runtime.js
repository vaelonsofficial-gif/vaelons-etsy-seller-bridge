export const SEO_APPROVAL = 'ONAYLIYORUM';
export const ROLLBACK_APPROVAL = 'GERI_AL ONAYLIYORUM';

const READ_SCOPES = ['vaelons:read'];
const WRITE_SCOPES = ['vaelons:read', 'vaelons:write'];

function required(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Plugin backend configuration is incomplete: ${name}`);
    error.status = 503;
    throw error;
  }
  return value;
}

function stripSensitive(value) {
  if (Array.isArray(value)) return value.map(stripSensitive);
  if (!value || typeof value !== 'object') return value;

  const blocked = new Set([
    'access_token',
    'refresh_token',
    'authorization',
    'api_key',
    'apikey',
    'shared_secret',
    'secret',
    'cookie',
    'etsy_token_capsule'
  ]);

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (blocked.has(String(key).toLowerCase())) continue;
    output[key] = stripSensitive(item);
  }
  return output;
}

async function parseJsonResponse(response) {
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'Backend returned a non-JSON response.' };
  }

  if (!response.ok) {
    const error = new Error(
      String(data?.error || data?.message || `Backend request failed (${response.status})`)
    );
    error.status = response.status;
    throw error;
  }

  return stripSensitive(data);
}

export async function sellerBridgeRequest(context, path, { method = 'GET', body } = {}) {
  const base = String(
    context?.origin || process.env.PLUGIN_SELLER_BRIDGE_URL || process.env.PUBLIC_BASE_URL || ''
  ).replace(/\/$/, '');
  if (!base) {
    const error = new Error('Seller Bridge base URL is not configured.');
    error.status = 503;
    throw error;
  }

  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${required('BRIDGE_API_KEY')}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });

  return parseJsonResponse(response);
}

export async function priceManagerRequest(context, path, { method = 'GET', body } = {}) {
  if (!context?.accessToken) {
    const error = new Error('OAuth access token is missing from plugin request context.');
    error.status = 401;
    throw error;
  }

  const base = String(
    process.env.PLUGIN_PRICE_MANAGER_URL || 'https://etsy-price-manager.vercel.app'
  ).replace(/\/$/, '');

  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${context.accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });

  return parseJsonResponse(response);
}

export function ok(data, summary) {
  return {
    structuredContent: data && typeof data === 'object' ? data : { value: data },
    content: [{ type: 'text', text: summary }]
  };
}

function failed(error) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(error?.message || 'VAELONS backend request failed.') }]
  };
}

export function registerTool(server, name, config, handler) {
  const scopes = config?.annotations?.readOnlyHint ? READ_SCOPES : WRITE_SCOPES;
  const securitySchemes = [{ type: 'oauth2', scopes }];
  server.registerTool(
    name,
    {
      ...config,
      securitySchemes,
      _meta: {
        ...(config?._meta || {}),
        securitySchemes
      }
    },
    async (args) => {
      try {
        return await handler(args || {});
      } catch (error) {
        return failed(error);
      }
    }
  );
}
