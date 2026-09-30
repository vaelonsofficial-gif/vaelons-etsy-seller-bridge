import { clerkMiddleware, getAuth } from '@clerk/express';
import {
  authServerMetadataHandlerClerk,
  mcpAuthClerk,
  protectedResourceHandlerClerk,
  streamableHttpHandler
} from '@clerk/mcp-tools/express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import cors from 'cors';
import { z } from 'zod';

const APPROVAL = 'ONAYLIYORUM';
const ROLLBACK_APPROVAL = 'GERI_AL ONAYLIYORUM';

function configured() {
  return Boolean(
    process.env.CLERK_PUBLISHABLE_KEY &&
      process.env.CLERK_SECRET_KEY &&
      process.env.PLUGIN_ALLOWED_CLERK_USER_IDS
  );
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Plugin configuration is incomplete: ${name}`);
    error.status = 503;
    throw error;
  }
  return value;
}

function allowedUserIds() {
  return new Set(
    required('PLUGIN_ALLOWED_CLERK_USER_IDS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
  );
}

function requireAllowedPluginUser(req, res, next) {
  try {
    const auth = getAuth(req, { acceptsToken: 'oauth_token' });
    const userId = auth?.userId;

    if (!auth?.isAuthenticated || !userId) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    if (!allowedUserIds().has(String(userId))) {
      return res.status(403).json({ error: 'forbidden' });
    }

    next();
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.status === 503 ? 'plugin_not_configured' : 'authorization_failed'
    });
  }
}

function bridgeBase() {
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
  if (Array.isArray(value)) {
    return value.map(stripSensitive);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

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
    data = { message: 'Backend returned a non-JSON response.' };
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

async function bridgeRequest(path, { method = 'GET', body } = {}) {
  const base = bridgeBase();
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

function result(data, summary = 'Request completed.') {
  return {
    structuredContent: data && typeof data === 'object' ? data : { value: data },
    content: [{ type: 'text', text: summary }]
  };
}

function errorResult(error) {
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

function register(server, name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args || {});
    } catch (error) {
      return errorResult(error);
    }
  });
}

function createServer() {
  const server = new McpServer(
    {
      name: 'vaelons-etsy-manager',
      version: '1.0.0'
    },
    {
      instructions:
        'Use read tools freely. Never publish or roll back SEO without the exact approval strings enforced by the tools. SEO publish must use the preview_token returned by a prepare tool. Do not expose backend secrets or OAuth credentials.'
    }
  );

  register(
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
    async () => result(await bridgeRequest('/api/token-status'), 'Etsy connection status retrieved.')
  );

  register(
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
    async () => result(await bridgeRequest('/api/shop'), 'VAELONS shop information retrieved.')
  );

  register(
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
      return result(
        await bridgeRequest(`/api/listings?${query.toString()}`),
        'VAELONS listings retrieved.'
      );
    }
  );

  register(
    server,
    'get_vaelons_listing',
    {
      title: 'Get one VAELONS listing',
      description: 'Reads one Etsy listing by its exact listing ID.',
      inputSchema: z.object({
        listing_id: z.string().regex(/^\d+$/)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async ({ listing_id }) =>
      result(
        await bridgeRequest(`/api/listings/${encodeURIComponent(listing_id)}`),
        'Listing retrieved.'
      )
  );

  register(
    server,
    'list_seo_listing_data',
    {
      title: 'List SEO listing data',
      description: 'Reads title, tags, description and SEO-relevant fields for VAELONS listings.',
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
      return result(
        await bridgeRequest(`/api/seo/listings?${query.toString()}`),
        'SEO listing data retrieved.'
      );
    }
  );

  register(
    server,
    'scan_seo_structure',
    {
      title: 'Scan SEO structure',
      description: 'Runs the existing deterministic VAELONS SEO structure scan. It does not modify Etsy.',
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
      result(
        await bridgeRequest('/api/seo/scan', { method: 'POST', body: input }),
        'SEO structure scan completed without publishing changes.'
      )
  );

  const seoProposalSchema = z.object({
    listing_id: z.string().regex(/^\d+$/),
    title: z.string().max(140).optional(),
    tags: z.array(z.string().max(20)).length(13).optional(),
    description: z.string().min(1).optional(),
    reason: z.string().max(500).optional()
  });

  register(
    server,
    'prepare_seo_optimization',
    {
      title: 'Prepare SEO optimization',
      description: 'Validates a proposed SEO change and creates the existing preview token. It does not publish to Etsy.',
      inputSchema: seoProposalSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ listing_id, ...proposal }) =>
      result(
        await bridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/prepare`, {
          method: 'POST',
          body: proposal
        }),
        'SEO preview prepared. Etsy was not modified.'
      )
  );

  register(
    server,
    'batch_prepare_seo_optimizations',
    {
      title: 'Prepare batch SEO optimizations',
      description: 'Creates preview tokens for up to 20 proposed SEO changes. It does not publish to Etsy.',
      inputSchema: z.object({
        items: z.array(seoProposalSchema).min(1).max(20)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ items }) =>
      result(
        await bridgeRequest('/api/seo/batch-prepare', { method: 'POST', body: { items } }),
        'Batch SEO previews prepared. Etsy was not modified.'
      )
  );

  register(
    server,
    'get_seo_optimization_status',
    {
      title: 'Get SEO optimization status',
      description: 'Reads the preview/publish/rollback status and recent SEO history for one listing.',
      inputSchema: z.object({
        listing_id: z.string().regex(/^\d+$/)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async ({ listing_id }) =>
      result(
        await bridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/status`),
        'SEO optimization status retrieved.'
      )
  );

  register(
    server,
    'publish_seo_optimization',
    {
      title: 'Publish approved SEO optimization',
      description: 'Publishes only the fields stored in an existing validated preview. Requires the exact approval text ONAYLIYORUM and the matching preview token.',
      inputSchema: z.object({
        listing_id: z.string().regex(/^\d+$/),
        preview_token: z.string().min(1),
        approval: z.literal(APPROVAL)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ listing_id, preview_token, approval }) =>
      result(
        await bridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/publish`, {
          method: 'POST',
          body: { preview_token, approval }
        }),
        'Approved SEO preview was sent to the existing publish gate.'
      )
  );

  register(
    server,
    'rollback_seo_optimization',
    {
      title: 'Rollback approved SEO optimization',
      description: 'Runs the existing guarded rollback for the last successful SEO publish. Requires the exact approval text GERI_AL ONAYLIYORUM.',
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
      result(
        await bridgeRequest(`/api/seo/listings/${encodeURIComponent(listing_id)}/rollback`, {
          method: 'POST',
          body: { approval }
        }),
        'Approved rollback request was sent to the existing rollback gate.'
      )
  );

  register(
    server,
    'list_vaelons_drafts',
    {
      title: 'List VAELONS Etsy drafts',
      description: 'Lists the current VAELONS draft listings using the existing Price/Schedule Manager backend.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async () =>
      result(await priceManagerRequest('/api/gpt/drafts'), 'VAELONS draft listings retrieved.')
  );

  register(
    server,
    'schedule_vaelons_drafts',
    {
      title: 'Schedule VAELONS draft publication',
      description: 'Schedules one or more current VAELONS drafts for future publication through the existing scheduler. Requires the exact approval text ONAYLIYORUM.',
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
        approval: z.literal(APPROVAL)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
        idempotentHint: false
      }
    },
    async ({ schedules }) =>
      result(
        await priceManagerRequest('/api/gpt/schedule', {
          method: 'POST',
          body: { schedules }
        }),
        'Approved draft publication schedule was created.'
      )
  );

  return server;
}

export function registerMcpRoutes(app) {
  const pluginCors = cors({
    origin: true,
    credentials: false,
    exposedHeaders: ['WWW-Authenticate'],
    allowedHeaders: ['Authorization', 'Content-Type', 'MCP-Protocol-Version', 'MCP-Session-Id']
  });

  app.options('/mcp', pluginCors);
  app.options('/.well-known/oauth-protected-resource/mcp', pluginCors);
  app.options('/.well-known/oauth-authorization-server', pluginCors);

  if (!configured()) {
    const unavailable = (_req, res) =>
      res.status(503).json({
        error: 'plugin_auth_not_configured',
        etsy_modified: false
      });

    app.get('/.well-known/oauth-protected-resource/mcp', pluginCors, unavailable);
    app.get('/.well-known/oauth-authorization-server', pluginCors, unavailable);
    app.post('/mcp', pluginCors, unavailable);
    return;
  }

  const clerk = clerkMiddleware();

  app.get(
    '/.well-known/oauth-protected-resource/mcp',
    pluginCors,
    protectedResourceHandlerClerk({
      scopes_supported: ['openid', 'profile', 'email']
    })
  );

  app.get(
    '/.well-known/oauth-authorization-server',
    pluginCors,
    authServerMetadataHandlerClerk
  );

  app.post(
    '/mcp',
    pluginCors,
    clerk,
    mcpAuthClerk,
    requireAllowedPluginUser,
    streamableHttpHandler(createServer)
  );
}
