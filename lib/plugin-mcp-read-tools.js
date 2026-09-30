import { z } from 'zod';
import {
  ok,
  priceManagerRequest,
  registerTool,
  sellerBridgeRequest
} from './plugin-mcp-runtime.js';

export function registerVaelonsReadTools(server, context) {
  registerTool(
    server,
    'get_connected_profile',
    {
      title: 'Get connected VAELONS profile',
      description: 'Returns the Etsy shop identity attached to the current OAuth connection.',
      inputSchema: z.object({}),
      outputSchema: z.object({
        id: z.string(),
        name: z.string(),
        nickname: z.string()
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      },
      _meta: { 'openai/profile': true }
    },
    async () => {
      const shop = context?.identity?.shop;
      if (!shop?.shop_id || !shop?.shop_name) {
        throw new Error('Connected VAELONS profile is unavailable.');
      }
      const profile = {
        id: String(shop.shop_id),
        name: String(shop.shop_name),
        nickname: `${shop.shop_name} Etsy`
      };
      return {
        structuredContent: profile,
        content: [{ type: 'text', text: JSON.stringify(profile) }]
      };
    }
  );

  registerTool(
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
    async () =>
      ok(
        await sellerBridgeRequest(context, '/api/token-status'),
        'Etsy connection status retrieved.'
      )
  );

  registerTool(
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
    async () =>
      ok(await sellerBridgeRequest(context, '/api/shop'), 'VAELONS shop information retrieved.')
  );

  registerTool(
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
        await sellerBridgeRequest(context, `/api/listings?${query.toString()}`),
        'VAELONS listings retrieved.'
      );
    }
  );

  registerTool(
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
        await sellerBridgeRequest(context, `/api/listings/${encodeURIComponent(listing_id)}`),
        'Listing retrieved.'
      )
  );

  registerTool(
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
        await sellerBridgeRequest(context, `/api/seo/listings?${query.toString()}`),
        'SEO listing data retrieved.'
      );
    }
  );

  registerTool(
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
        await sellerBridgeRequest(context, '/api/seo/scan', { method: 'POST', body: input }),
        'SEO structure scan completed without publishing changes.'
      )
  );

  registerTool(
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
        await sellerBridgeRequest(context, `/api/seo/listings/${encodeURIComponent(listing_id)}/status`),
        'SEO optimization status retrieved.'
      )
  );

  registerTool(
    server,
    'list_vaelons_drafts',
    {
      title: 'List VAELONS Etsy drafts',
      description: 'Lists current VAELONS draft listings using the OAuth-protected Price/Schedule Manager backend.',
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true
      }
    },
    async () =>
      ok(
        await priceManagerRequest(context, '/api/plugin/drafts'),
        'VAELONS draft listings retrieved.'
      )
  );
}
