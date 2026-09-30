# VAELONS Etsy Manager — ChatGPT Plugin migration

Status: staged only. Do not disable or remove the existing Custom GPT Actions until the authenticated MCP checks below pass.

## Goal

Expose the existing VAELONS Etsy Manager workflows through a remote MCP endpoint while keeping the existing Etsy backend, preview-token gates, approval strings, OAuth data, and scheduler behavior intact.

## Existing systems kept intact

- Seller/SEO bridge: existing `/api/*` and `/api/seo/*` routes.
- Existing Custom GPT OpenAPI Actions: unchanged.
- Price/Schedule Manager: existing `etsy-price-manager` backend and durable workflow.
- Existing Etsy OAuth and backend secrets: remain server-side.

## New Plugin surface

- MCP endpoint: `/api/mcp`
- OAuth protected-resource metadata:
  - `/.well-known/oauth-protected-resource`
  - `/.well-known/oauth-protected-resource/api/mcp`
- OAuth authorization-server metadata: `/.well-known/oauth-authorization-server`

OAuth is fail-closed. The MCP endpoint returns `503 plugin_auth_not_configured` until the plugin authentication environment is configured.

## Authentication

The Plugin uses Clerk OAuth for the ChatGPT-to-MCP user session. Existing Etsy credentials and backend API keys are never sent to ChatGPT.

Required Plugin-host environment variable names:

- `CLERK_PUBLISHABLE_KEY` (or `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`)
- `CLERK_SECRET_KEY`
- `PLUGIN_ALLOWED_CLERK_USER_IDS`
- `PLUGIN_PRICE_MANAGER_ACTION_TOKEN`

Optional explicit backend locations:

- `PLUGIN_SELLER_BRIDGE_URL`
- `PLUGIN_PRICE_MANAGER_URL` (defaults to `https://etsy-price-manager.vercel.app`)

Existing Seller Bridge secret used server-side:

- `BRIDGE_API_KEY`

Never place secret values in source control, MCP tool output, or chat messages.

## MCP tool inventory

1. `get_etsy_connection_status`
2. `get_vaelons_shop`
3. `list_vaelons_listings`
4. `get_vaelons_listing`
5. `list_seo_listing_data`
6. `scan_seo_structure`
7. `prepare_seo_optimization`
8. `batch_prepare_seo_optimizations`
9. `get_seo_optimization_status`
10. `publish_seo_optimization`
11. `rollback_seo_optimization`
12. `list_vaelons_drafts`
13. `schedule_vaelons_drafts`

## Write gates

- SEO publish requires the existing valid preview token and exact approval: `ONAYLIYORUM`.
- SEO rollback requires exact approval: `GERI_AL ONAYLIYORUM`.
- Draft scheduling additionally requires exact `ONAYLIYORUM` at the MCP layer.
- The existing Seller Bridge snapshot/preview validation remains authoritative.
- No Etsy production write is permitted as a migration test.

## Recommended rollout

1. Keep `vaelons-etsy-seller-bridge-3dql` as the current Actions host during validation.
2. Use the duplicate `vaelons-etsy-seller-bridge-x2bh` project as the Plugin staging host when OAuth environment values are available.
3. Run authenticated read-only MCP tests: connection status, shop, listings, single listing, SEO listing read, SEO scan, and draft list.
4. Verify tool discovery, OAuth, schema handling, and zero Etsy mutation.
5. Only after all checks pass, promote the additive MCP changes to the stable Seller Bridge host if desired.
6. Keep the old Custom GPT Actions available through a rollback window; do not remove them merely because MCP is deployed.

## Read-only acceptance checks

- Etsy connection read returns success through MCP.
- Shop read returns VAELONS identity.
- Listing list and single listing read succeed.
- SEO listing data and structural scan succeed without Etsy mutation.
- Draft list succeeds through the Price Manager bridge.
- Unauthorized MCP access fails closed.
- Existing Action endpoints continue to return their prior responses.
- Production write endpoints are not invoked during migration validation.
