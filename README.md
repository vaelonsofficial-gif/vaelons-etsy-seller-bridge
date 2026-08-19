# VAELONS Etsy Seller Bridge

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
