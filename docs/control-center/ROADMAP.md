# VAELONS Control Center — Delivery Roadmap

## Phase 0 — Discovery and architecture freeze
Goal: understand current reusable Etsy capabilities and lock boundaries before app code.

Deliverables:
- inventory existing bridge capabilities
- map Etsy read/write/image functions
- identify unsupported Etsy Ads data paths
- define database and queue strategy
- define UI information architecture
- define score formulas and confidence model
- define rollback policy

Exit criteria:
- no unresolved architectural decision that could force a rewrite of core modules

## Phase 1 — Read-only Control Center
Goal: private web UI that safely mirrors the shop.

Deliverables:
- app shell/navigation
- system health page
- catalog sync endpoint
- listing table/cards
- listing detail page
- image gallery/ranks
- title/tags/description display
- sync history
- no-write enforcement

Exit criteria:
- entire catalog can be synced repeatedly without duplicates
- wrong-shop identity blocks the app
- zero Etsy mutations from the Control Center

## Phase 2 — Audit Engine
Goal: explainable listing diagnosis.

Deliverables:
- title audit
- tags/intent audit
- description audit
- trust audit
- image-set completeness audit
- hero-image audit
- conversion readiness score
- ad readiness score
- finding severity and confidence

Exit criteria:
- manual review of a representative listing set agrees with system findings at an acceptable rate

## Phase 3 — Creative Studio
Goal: generate better presentation assets without altering artwork truth.

Deliverables:
- artwork/reference selector
- creative repair recipe generator
- generated asset preview
- artwork-preservation validation
- image-set comparison
- upload candidate staging

Exit criteria:
- generated assets pass reference-preservation checks before any Etsy upload is enabled

## Phase 4 — Safe Write
Goal: verified, reversible Etsy mutations.

Deliverables:
- action queue
- pre-write snapshots
- title/tags/description safe update path
- image upload/rank path
- post-write verification
- rollback records
- global write lock

Rollout:
1 listing -> 3 listings -> 10 listings -> bounded batch

Exit criteria:
- repeated test writes verify correctly
- rollback is proven for supported mutation types

## Phase 5 — Performance & Ads Intelligence
Goal: decide where money should and should not be spent.

Deliverables:
- ingest available performance data
- performance snapshots by listing/date
- spend/click/order decision rules
- unknown-data handling
- SCALE / KEEP / TEST / REPAIR / ADS_OFF / KILL classification
- cooldown and reassessment windows

Exit criteria:
- decisions are explainable and traceable to data
- no ad-state action occurs when required data is missing

## Phase 6 — Controlled Autopilot
Goal: let proven low-risk rules execute automatically.

Autopilot candidates:
- catalog synchronization
- health checks
- audits
- proposal generation
- low-risk metadata repairs after policy promotion

Initially approval-gated:
- image replacement/deletion
- broad catalog edits
- price changes
- discount changes
- ad enable/disable unless a verified Etsy write path and explicit operating policy exist

## Phase 7 — Optimization loop
Goal: learn from outcomes rather than constantly editing.

Deliverables:
- before/after measurement windows
- listing change timeline
- experiment notes
- winning hero patterns
- trust-content effectiveness patterns
- category-specific rules
- spend efficiency dashboard

## Development discipline
- one phase at a time
- no emergency rewrites to skip architecture
- small commits
- preview/staging validation before production
- production bridge remains available throughout migration
- scheduling project stays untouched until separately reopened
