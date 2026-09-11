# VAELONS Control Center — Guardrails

## Rule 1 — Owner support only when necessary
The assistant performs every technically available GitHub, Vercel, Etsy, deployment, coding, testing, analysis, and system-maintenance action directly. The owner is asked to act only when a human/account-holder step is technically required, such as 2FA, external authorization consent, or entering a secret that must not be shared in chat.

## Rule 2 — Scheduling system isolation
The `etsy-price-manager` repository and its listing scheduling workflow are frozen and out of scope until the owner explicitly reopens that workstream.

## Rule 3 — Production isolation
`main` is not a development workspace. New Control Center work occurs on `control-center-v1` or later dedicated branches until validated.

## Rule 4 — No blind writes
Before every Etsy mutation:
1. fetch current state,
2. save snapshot,
3. validate intended target,
4. execute one bounded action,
5. fetch again,
6. verify exact outcome,
7. record rollback data.

If any step fails, stop the sequence.

## Rule 5 — Artwork lock
The source artwork is product truth.
Generated mockups and information images must preserve it. No generated asset may silently replace or reinterpret the artwork.

## Rule 6 — Claims must be supportable
Do not publish material, longevity, waterproofing, UV resistance, archival, handmade, museum-quality, delivery-time, warranty, customs, or similar claims unless supported by the actual product/fulfillment data available to the system.

## Rule 7 — Missing data is unknown
No metric may be converted from missing/null to zero. Ad and conversion decisions must show confidence and missing-data warnings.

## Rule 8 — Ad decisions need evidence
Ads are not enabled because a listing is new or visually attractive. They require Ad Readiness plus sufficient evidence or a defined test budget/window.

## Rule 9 — Change cooldown
A listing that receives a material SEO, hero image, price, or offer change enters a measurement cooldown. The system must avoid rapid repeated edits that destroy attribution.

## Rule 10 — Global kill switch
A global write lock must exist. Token errors, wrong-shop identity, malformed catalog data, failed verification, or repeated API errors automatically activate it.

## Rule 11 — Explainability
Every automatic recommendation must answer:
- What is wrong?
- What evidence supports it?
- What will change?
- What result do we expect?
- When will we reassess?

## Rule 12 — No mass mutation in early phases
SAFE_WRITE begins with one listing, then a tiny batch, then a bounded group. Bulk catalog mutation is allowed only after the same operation has passed repeated verification.

## Rule 13 — Reversible by design
If a planned action cannot be safely rolled back, the UI must label it high risk and prevent autonomous execution until a separate policy explicitly allows it.

## Rule 14 — Idempotency
Every queued action has a unique idempotency key. Retries must not duplicate image uploads, repeated edits, or other Etsy mutations.

## Rule 15 — Logs are permanent operational evidence
Every sync, audit, proposal, execution, failure, verification and rollback event is logged with timestamps and target IDs.
