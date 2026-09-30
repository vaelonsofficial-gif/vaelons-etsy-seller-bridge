import { z } from 'zod';

export const SEO_APPROVAL = 'ONAYLIYORUM';
export const ROLLBACK_APPROVAL = 'GERI_AL ONAYLIYORUM';

export function pluginAuthConfigured() {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY &&
      process.env.CLERK_SECRET_KEY &&
      process.env.PLUGIN_ALLOWED_CLERK_USER_IDS
  );
}

export function allowedPluginUserIds() {
  return new Set(
    String(process.env.PLUGIN_ALLOWED_CLERK_USER_IDS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Plugin backend configuration is incomplete: ${name}`);
    error.status = 503;
    throw error;
  }
  return value;
}

function sellerBridgeBase() {
  return String(
    process.env.PLUGIN_SELLER_BRIDGE_URL || process.env.PUBLIC_BASE_URL || ''
  ).replace(/\/$/, '');
}

function priceManagerBase() {
  return String(
    process.env.PLUGIN_PRICE_MANAGER_URL || 'https://etsy-price-manager.vercel.app'
  ).replace(/\/$/, '');
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
    if (key === 'runId' || key === 'run_id') continue;
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

async function sellerBridgeRequest(path, { method = 'GET', body } = {}) {
  const base = sellerBridgeBase();
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

async function priceManagerRequest(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${priceManagerBase()}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${required('PLUGIN_PRICE_MANAGER_ACTION_TOKEN')}`,
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store'
  });

  return parseJsonResponse(response);
}

function ok(data, summary) {
  return {
    structuredContent: data && typeof data === 'object' ? data : { value: data },
    content: [{ type: 'text', text: summary }]
  };
}

function failed(error) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: String(error?.message || 'VAELONS backend request failed.')
      }
    ]
  };
}

function tool(server, name, config, fn) {
  server.registerTool(name, config, async (args) => {
    try {
      return await fn(args || {});
    } catch (error) {
      return failed(error);
    }
  });
}

export function registerVaelonsMcpTools(server) {
  tool(
    server,
    'get_etsy_connection_status',
    {
      title: 'Check Etsy connection',
      description: 'Checks the VAELONS Etsy connection status without modifying Etsy.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async () => ok(await sellerBridgeRequest('/api/token-status'), 'Etsy connection status retrieved.')
  );

  tool(
    server,
    'get_vaelons_shop',
    {
      title: 'Get VAELONS shop',
      description: 'Reads the connected VAELONS Etsy shop information.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async () => ok(await sellerBridgeRequest('/api/shop'), 'VAELONS shop information retrieved.')
  );

  tool(
    server,
    'list_vaelons_listings',
    {
      title: 'List VAELONS listings',
      description: 'Lists Etsy listings for the connected VAELONS shop without modifying them.',
      inputSchema: z.object({
        state: z.string().max(32).default('active'),
        limit: z.number().int().min(1).max(100).default(25),
        offset: z.number().int().min(0).default(0)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async ({ state, limit, offset }) => {
      const query = new URLSearchParams({
        state,
        limit: String(limit),
        offset: String(offset)
      });
      return ok(
        await sellerBridgeRequest(`/api/listings?${query.toString()}`),
        'VAELONS listings retrieved.'
      );
    }
  );

  tool(
    server,
    'get_vaelons_listing',
    {
      title: 'Get one VAELONS listing',
      description: 'Reads one Etsy listing by its exact listing ID.',
      inputSchema: z.object({ listing_id: z.string().regex(/^\d+$/) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async ({ listing_id }) =>
      ok(
        await sellerBridgeRequest(`/api/listings/${encodeURIComponent(listing_id)}`),
        'Listing retrieved.'
      )
  );

  tool(
    server,
    'list_seo_listing_data',
    {
      title: 'List SEO listing data',
      description: 'Reads current title, tags, description and SEO-relevant fields for VAELONS listings.',
      inputSchema: z.object({
        state: z.string().max(32).default('active'),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async ({ state, limit, offset }) => {
      const query = new URLSearchParams({
        state,
        limit: String(limit),
        offset: String(offset)
      });
      return ok(
        await sellerBridgeRequest(`/api/seo/listings?${query.toString()}`),
        'SEO listing data retrieved.'
      );
    }
  );

  tool(
    server,
    'scan_seo_structure',
    {
      title: 'Scan SEO structure',
      description: 'Runs the existing deterministic VAELONS SEO structure scan. It never publishes Etsy changes.',
      inputSchema: z.object({
        state: z.string().max(32).default('active'),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async (input) =>
      ok(
        await sellerBridgeRequest('/api/seo/scan', { method: 'POST', body: input }),
        'SEO structure scan completed without publishing changes.'
      )
  );

  const seoProposal = z.object({
    listing_id: z.string().regex(/^\d+$/),
    title: z.string().max(140).optional(),
    tags: z.array(z.string().max(20)).length(13).optional(),
    description: z.string().min(1).optional(),
    reason: z.string().max(500).optional()
  });

  tool(
    server,
    'prepare_seo_optimization',
    {
      title: 'Prepare SEO optimization',
      description: 'Validates a proposed SEO change and creates the existing preview token. It does not publish to Etsy.',
      inputSchema: seoProposal,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ listing_id, title, tags, description, reason }) =>
      ok(
        await sellerBridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/prepare`, {
          method: 'POST',
          body: {
            ...(title !== undefined ? { proposed_title: title } : {}),
            ...(tags !== undefined ? { proposed_tags: tags } : {}),
            ...(description !== undefined ? { proposed_description: description } : {}),
            ...(reason !== undefined ? { reason } : {})
          }
        }),
        'SEO preview prepared. Etsy was not modified.'
      )
  );

  tool(
    server,
    'batch_prepare_seo_optimizations',
    {
      title: 'Prepare batch SEO optimizations',
      description: 'Creates preview tokens for up to 20 SEO proposals. It does not publish to Etsy.',
      inputSchema: z.object({ items: z.array(seoProposal).min(1).max(20) }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ items }) => {
      const normalized = items.map(({ listing_id, title, tags, description, reason }) => ({
        listing_id,
        ...(title !== undefined ? { proposed_title: title } : {}),
        ...(tags !== undefined ? { proposed_tags: tags } : {}),
        ...(description !== undefined ? { proposed_description: description } : {}),
        ...(reason !== undefined ? { reason } : {})
      }));

      return ok(
        await sellerBridgeRequest('/api/seo/batch-prepare', {
          method: 'POST',
          body: { items: normalized }
        }),
        'Batch SEO previews prepared. Etsy was not modified.'
      );
    }
  );

  tool(
    server,
    'get_seo_optimization_status',
    {
      title: 'Get SEO optimization status',
      description: 'Reads preview/publish/rollback status and recent SEO history for one listing.',
      inputSchema: z.object({ listing_id: z.string().regex(/^\d+$/) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async ({ listing_id }) =>
      ok(
        await sellerBridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/status`),
        'SEO optimization status retrieved.'
      )
  );

  tool(
    server,
    'publish_seo_optimization',
    {
      title: 'Publish approved SEO optimization',
      description: 'Publishes only an existing validated preview. Requires the exact approval text ONAYLIYORUM and its matching preview token.',
      inputSchema: z.object({
        listing_id: z.string().regex(/^\d+$/),
        preview_token: z.string().min(1),
        approval: z.literal(SEO_APPROVAL)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ listing_id, preview_token, approval }) =>
      ok(
        await sellerBridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/publish`, {
          method: 'POST',
          body: { preview_token, approval }
        }),
        'Approved SEO preview was sent through the existing publish gate.'
      )
  );

  tool(
    server,
    'rollback_seo_optimization',
    {
      title: 'Rollback approved SEO optimization',
      description: 'Runs the existing guarded rollback for the latest successful SEO publish. Requires the exact approval text GERI_AL ONAYLIYORUM.',
      inputSchema: z.object({
        listing_id: z.string().regex(/^\d+$/),
        approval: z.literal(ROLLBACK_APPROVAL)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ listing_id, approval }) =>
      ok(
        await sellerBridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/rollback`, {
          method: 'POST',
          body: { approval }
        }),
        'Approved rollback request was sent through the existing rollback gate.'
      )
  );

  tool(
    server,
    'list_vaelons_drafts',
    {
      title: 'List VAELONS Etsy drafts',
      description: 'Lists current VAELONS draft listings using the existing Price/Schedule Manager backend.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async () => ok(await priceManagerRequest('/api/gpt/drafts'), 'VAELONS draft listings retrieved.')
  );

  tool(
    server,
    'schedule_vaelons_drafts',
    {
      title: 'Schedule VAELONS draft publication',
      description: 'Schedules current VAELONS drafts for future publication through the existing scheduler. Requires the exact approval text ONAYLIYORUM.',
      inputSchema: z.object({
        schedules: z
          .array(
            z.object({
              listingId: z.string().regex(/^\d+$/),
              publishAt: z.string().datetime({ offset: true })
            })
          )
          .min(1)
          .max(100),
        approval: z.literal(SEO_APPROVAL)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ schedules }) =>
      ok(
        await priceManagerRequest('/api/gpt/schedule', {
          method: 'POST',
          body: { schedules }
        }),
        'Approved draft publication schedule was created.'
      )
  );
}
