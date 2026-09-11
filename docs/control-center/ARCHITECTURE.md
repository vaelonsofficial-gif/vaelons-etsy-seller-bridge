# VAELONS Control Center — Architecture v1

## Mission
VAELONS Control Center is a private, browser-based operating system for the VAELONS Etsy shop. It audits every listing, prioritizes work, generates and replaces weak presentation assets, manages SEO/content changes, evaluates advertising decisions, records every action, and prevents unsafe writes.

## Non-negotiable boundaries
1. The existing `main` branch remains the production Etsy bridge until the Control Center passes staged validation.
2. The separate `etsy-price-manager` repository, including its scheduling workflow, is out of scope and must not be modified unless explicitly requested later.
3. Artwork is immutable product truth. Presentation images may change; the source artwork must not be repainted, cropped destructively, altered, extended, recolored, or replaced by an approximation.
4. No destructive Etsy write occurs without a pre-action snapshot and a rollback record.
5. If authentication, Etsy API health, image validation, or data integrity checks fail, writes stop automatically.
6. Development progresses READ ONLY → SAFE WRITE → AUTOPILOT. No phase may be skipped.

## System layers

### 1. Web Control Center
Private desktop-first dashboard with responsive tablet/mobile support.
Primary screens:
- Overview
- Listings
- Listing Detail
- Creative Audit
- SEO & Trust Audit
- Ads Decisions
- Action Queue
- Audit Log / Rollback
- System Health
- Settings

### 2. Etsy Connector
Reuses proven Etsy OAuth/token and shop validation logic from the existing bridge.
Responsibilities:
- Shop identity validation
- Token refresh
- Listing read
- Listing write
- Listing image read/upload/rank/delete where supported
- Inventory/variation read
- Shipping/processing data read where available
- Rate-limit and retry handling

The connector must expose typed internal methods rather than letting UI code call Etsy endpoints directly.

### 3. Catalog Sync
Maintains a normalized local snapshot of Etsy listings.
Each sync records:
- listing id
- state/status
- title
- description
- tags
- taxonomy/attributes
- price/currency
- sale/discount context when available
- shipping/processing summary
- variations/inventory summary
- image set + ranks + image IDs
- timestamps
- source revision hash

Catalog sync is idempotent. Re-running it must not create duplicate records.

### 4. Audit Engine
Produces explainable scores rather than one opaque score.
Required scores:
- Artwork/Product Truth score
- Hero Thumbnail score
- Image Set score
- SEO score
- Title score
- Description score
- Trust score
- Offer/Price Context score
- Conversion Readiness score
- Ad Readiness score

Every score must include reasons, evidence, and next actions.

### 5. Creative Engine
Detects presentation weaknesses and produces repair jobs.
Repair types:
- hero thumbnail
- scale/room context image
- sizes image
- frame options image
- ready-to-hang image
- materials/quality image
- production/process image
- packaging image
- tracked shipping image
- Safe Arrival Guarantee image

Creative validation rules:
- preserve source artwork identity
- no accidental crop of critical artwork content
- no invented product characteristics
- no misleading physical texture
- no false frame/material representation
- compare generated result against reference before upload

### 6. SEO & Conversion Engine
Evaluates the listing as one search-and-conversion unit, not keyword stuffing.
Checks:
- buyer-readable title
- primary search intent alignment
- keyword/tag coverage without duplication abuse
- attributes/category consistency
- first description paragraph
- technical product facts
- processing time clarity
- tracked shipping clarity
- damage/replacement policy clarity
- size/frame clarity
- unsupported claims

### 7. Performance & Ads Engine
Separates observation from action.
Decision classes:
- SCALE
- KEEP
- TEST
- REPAIR
- ADS_OFF
- KILL

Signals when available:
- impressions
- clicks
- CTR
- CPC
- favorites
- carts
- orders
- revenue
- ad spend
- ROAS
- contribution margin
- listing age
- recent creative/SEO change age

The engine must never infer missing performance data as zero. Missing data is `unknown`.

### 8. Action Queue
All writes become queued actions with a state machine:
`PROPOSED -> VALIDATED -> READY -> EXECUTING -> VERIFIED -> COMPLETED`
Failure states:
`BLOCKED`, `FAILED`, `ROLLED_BACK`

Each action stores:
- target listing
- exact change
- reason
- before snapshot
- expected after state
- validation results
- execution result
- verification result
- rollback payload

Conflicting writes to the same listing are serialized.

### 9. Audit Log & Rollback
Every mutation receives an immutable action record.
Rollback coverage must include at minimum:
- title
- description
- tags
- image ranks
- replaced/added images where technically possible
- configuration changes made by Control Center

### 10. System Health
Health checks:
- Etsy token status
- Etsy shop identity
- Etsy read test
- Etsy safe-write capability status
- bridge/API status
- database status
- job queue status
- image generation status
- last successful catalog sync

Critical health failure sets global write mode to LOCKED.

## Data model — minimum entities
- `shops`
- `listings`
- `listing_snapshots`
- `listing_images`
- `audit_runs`
- `audit_findings`
- `performance_snapshots`
- `ad_decisions`
- `creative_jobs`
- `generated_assets`
- `action_queue`
- `action_events`
- `rollback_records`
- `system_health_events`
- `settings`

## Operating modes
### READ_ONLY
Reads and scores. No Etsy mutations.

### SAFE_WRITE
Only explicitly eligible actions can write. One listing at a time. Mandatory verification and rollback snapshot.

### AUTOPILOT
Only rules that have passed staged tests may auto-execute. High-risk actions remain approval-gated unless explicitly promoted later.

## Initial technical direction
- Frontend: Next.js + React
- Backend: server-side API layer
- Existing Etsy connector logic: reused/refactored from bridge
- Persistence: durable database; Redis may be used for locks/cache/queue but is not the source of truth
- Background jobs: explicit queue with idempotency keys
- Hosting: Vercel-compatible web layer; existing production bridge remains isolated until migration is proven safe

## First release definition
Release 0.1 is successful when the system can:
1. authenticate to the existing VAELONS Etsy connection safely,
2. sync the catalog read-only,
3. display listing cards and detail views,
4. calculate transparent audit scores,
5. show proposed actions without executing them,
6. record sync/audit history,
7. pass production-identity and no-write safety tests.

No image replacement, SEO mutation, or ad-state mutation belongs in Release 0.1.
