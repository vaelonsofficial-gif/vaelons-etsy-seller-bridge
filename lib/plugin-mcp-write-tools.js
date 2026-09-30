import { z } from 'zod';
import {
  SEO_APPROVAL,
  ROLLBACK_APPROVAL,
  ok,
  priceManagerRequest,
  registerTool,
  sellerBridgeRequest
} from './plugin-mcp-runtime.js';

export function registerVaelonsWriteTools(server, context) {
  const seoProposal = z.object({
    listing_id: z.string().regex(/^\d+$/),
    title: z.string().max(140).optional(),
    tags: z.array(z.string().max(20)).length(13).optional(),
    description: z.string().min(1).optional(),
    reason: z.string().max(500).optional()
  });

  registerTool(
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
        await sellerBridgeRequest(context, `/api/seo/listings/${encodeURIComponent(listing_id)}/prepare`, {
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

  registerTool(
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
        await sellerBridgeRequest(context, '/api/seo/batch-prepare', {
          method: 'POST',
          body: { items: normalized }
        }),
        'Batch SEO previews prepared. Etsy was not modified.'
      );
    }
  );

  registerTool(
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
        await sellerBridgeRequest(context, `/api/seo/listings/${encodeURIComponent(listing_id)}/publish`, {
          method: 'POST',
          body: { preview_token, approval }
        }),
        'Approved SEO preview was sent through the existing publish gate.'
      )
  );

  registerTool(
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
        await sellerBridgeRequest(context, `/api/seo/listings/${encodeURIComponent(listing_id)}/rollback`, {
          method: 'POST',
          body: { approval }
        }),
        'Approved rollback request was sent through the existing rollback gate.'
      )
  );

  registerTool(
    server,
    'schedule_vaelons_drafts',
    {
      title: 'Schedule VAELONS draft publication',
      description: 'Schedules current VAELONS drafts for future publication. Requires the exact approval text ONAYLIYORUM.',
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
    async ({ schedules, approval }) =>
      ok(
        await priceManagerRequest(context, '/api/plugin/schedule', {
          method: 'POST',
          body: { schedules, approval }
        }),
        'Approved draft publication schedule was created.'
      )
  );
}
