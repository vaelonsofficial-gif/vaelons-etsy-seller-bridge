# VAELONS Etsy Seller Bridge

## Control Center preview

The `control-center-v1` branch extends the proven Etsy connector with a private, desktop-first VAELONS operations interface. Version 0.5 includes verified catalog reads, listing detail pages, image-rank visibility, deterministic metadata validation, a durable action queue adapter, per-listing locks, post-write verification, metadata rollback, a Creative Audit queue, and a command-driven content approval workflow.

From one listing panel the owner can issue a Turkish-language instruction, prepare a complete English Etsy title/tag/description proposal through Vercel AI Gateway, inspect and edit the exact before/after diff, and explicitly approve the verified patch. Content generation never writes to Etsy. Every model call receives a durable generation ID before execution and stores its command, output, validation, token use, estimated cost, timestamps, linked action, and event trail.

Creative Audit keeps technical integrity separate from visual judgment. It verifies image IDs, ranks, URLs, dimensions, hero resolution and 10-role capacity, then records a deterministic manifest hash. Artwork locking and AI vision are fail-closed: no visual-quality score, creative-readiness score, generation or upload is allowed until a source artwork is explicitly selected and the configured vision review has actually run.

Etsy mutations are fail-closed by default. Enabling a bounded SAFE_WRITE test requires all four independent conditions: `CONTROL_CENTER_WRITE_MODE=SAFE_WRITE`, `CONTROL_CENTER_KILL_SWITCH=OFF`, `CONTROL_CENTER_AUTH_READY=true`, and an exact `CONTROL_CENTER_SAFE_LISTING_ID`. AUTOPILOT cannot be enabled from environment variables alone.

Content preparation uses `openai/gpt-5.6-sol` by default. On Vercel it authenticates through `VERCEL_OIDC_TOKEN`; `AI_GATEWAY_API_KEY` is the manual alternative. `CONTROL_CENTER_CONTENT_AI_ENABLED=off` disables generation, and `CONTROL_CENTER_CONTENT_MODEL` can select another currently supported Gateway model. These settings never unlock Etsy writes.

The scheduling workflow in the separate `etsy-price-manager` project is out of scope and remains untouched.

A small, private bridge between ChatGPT Custom Actions and the official Etsy Open API v3.

## Safety choices
- Requests only `listings_r listings_w shops_r shops_w`.
- **No delete scope** and no delete endpoints.
- Every `/api/*` route requires `BRIDGE_API_KEY`.
- Etsy OAuth uses PKCE + state.
- OAuth token data is encrypted at rest with AES-256-GCM when `TOKEN_STORE_PATH` is writable.

## Environment variables
Copy `.env.example` and fill it in.

Required:
- `PUBLIC_BASE_URL`
- `ETSY_KEYSTRING`
- `ETSY_SHARED_SECRET`
- `ETSY_EXPECTED_SHOP_NAME` (defaults to `VAELONS`)
- `BRIDGE_API_KEY`
- `SETUP_SECRET`
- `TOKEN_ENCRYPTION_KEY`

Optional:
- `ETSY_REFRESH_TOKEN`
- `TOKEN_STORE_PATH`

## Etsy Seller App setup
1. Etsy Developer Portal → **Create a seller app**.
2. Register the exact callback URL: `https://YOUR-DOMAIN/oauth/etsy/callback`.
3. Copy the app keystring and shared secret into backend secrets.
4. Deploy this bridge. The numeric shop ID is auto-detected from the authorized Etsy account and checked against `VAELONS`.
5. Open: `https://YOUR-DOMAIN/oauth/etsy/start?setup_secret=YOUR_SETUP_SECRET`
6. Approve the requested permissions. The callback verifies the token can read the configured VAELONS shop.

## ChatGPT Custom Action setup
1. Create/edit a GPT → Actions → Create new action.
2. Replace `YOUR-DEPLOYED-DOMAIN` in `openapi-action.yaml` with the deployed domain and paste/import the schema.
3. Authentication: API Key → Bearer. Use the same value as `BRIDGE_API_KEY`.
4. Test `getEtsyConnectionStatus`, then `listVaelonsListings`.

## Run locally
```bash
npm install
npm start
```

## Notes
- Listing image upload is implemented in the server but omitted from the Custom Action schema because GPT Actions file-upload behavior may vary. It can be added later once the deployed environment is confirmed.
- Price/inventory edits are intentionally excluded from v1 because variation-aware listings should be handled through Etsy inventory endpoints rather than blindly overwriting listing fields.


## Vercel v2 token storage
This Vercel-safe build does not write OAuth tokens to local disk. After OAuth, copy the encrypted capsule shown in the browser into `ETSY_TOKEN_CAPSULE` in Vercel, then redeploy.


## v3 fix
Adds the OAuth Bearer header when resolving the authorized seller's shop from the Etsy user ID.
Production environment refresh
