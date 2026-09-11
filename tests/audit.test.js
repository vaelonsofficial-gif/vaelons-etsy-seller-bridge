import test from 'node:test';
import assert from 'node:assert/strict';
import { auditListing } from '../lib/control-center/audit.js';

const completeDescription = `Ready to hang cotton canvas on a solid wood frame.
Free worldwide shipping with tracking number. Made to order in 3–5 business days.
Safe Arrival Guarantee: if it arrives damaged, a replacement is provided at no cost.
See the size and dimensions chart. Black frame, gold frame and natural frame options.
Protective corner guards and a sturdy box are used for secure packaging.
Color may vary slightly because of monitor settings. Wipe clean with a dry cloth. `.repeat(3);

function listing(overrides = {}) {
  return {
    listing_id: 123,
    title: 'Mediterranean Door Canvas Wall Art, Coastal Living Room Decor',
    description: completeDescription,
    state: 'active',
    tags: ['canvas wall art', 'mediterranean art', 'coastal decor', 'doorway print', 'blue wall decor', 'living room art', 'italian wall art', 'summer artwork', 'ready to hang', 'framed canvas', 'travel wall art', 'villa decor', 'premium canvas'],
    taxonomy_id: 1,
    price: { amount: 89, currency: 'USD' },
    image_count: 12,
    hero_url: 'https://example.com/hero.jpg',
    ...overrides
  };
}

test('metadata-only audit never enables ads or claims conversion readiness', () => {
  const result = auditListing(listing());
  assert.equal(result.ads_eligible, false);
  assert.equal(result.ad_readiness, null);
  assert.equal(result.conversion_readiness, null);
  assert.equal(result.confidence, 'metadata_only');
  assert.equal(result.decision, 'REVIEW_REQUIRED');
});

test('missing hero image blocks the listing', () => {
  const result = auditListing(listing({ hero_url: null, image_count: 0 }));
  assert.equal(result.decision, 'BLOCKED');
  assert.ok(result.findings.includes('Ana görsel eksik'));
});

test('incomplete trust information routes the listing to repair', () => {
  const result = auditListing(listing({ description: 'Canvas wall art. Ready to hang.' }));
  assert.equal(result.decision, 'REPAIR');
  assert.ok(result.trust_score < 78);
});

test('image count alone is capped and requires visual review', () => {
  const result = auditListing(listing({ image_count: 99 }));
  assert.equal(result.image_score, 75);
  assert.equal(result.requires_visual_review, true);
});

test('unverified product claims are surfaced and cap trust', () => {
  const result = auditListing(listing({
    description: `${completeDescription}\nMuseum-quality, UV-resistant and waterproof for 75+ years.`
  }));

  assert.equal(result.claim_review_required, true);
  assert.ok(result.unverified_claims.some((claim) => claim.key === 'museum quality'));
  assert.ok(result.unverified_claims.some((claim) => claim.key === 'uv resistant'));
  assert.ok(result.trust_score <= 50);
  assert.ok(result.findings.some((finding) => finding.startsWith('Ürün verisiyle doğrulanması gereken iddialar:')));
});
