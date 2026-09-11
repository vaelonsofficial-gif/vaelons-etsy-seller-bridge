import test from 'node:test';
import assert from 'node:assert/strict';

import {
  auditCreativeListing,
  creativeImageManifestHash
} from '../lib/control-center/creative-audit.js';

function image(index, overrides = {}) {
  return {
    image_id: 1000 + index,
    rank: index,
    width: 3000,
    height: 2500,
    url_fullxfull: `https://example.com/image-${index}.jpg`,
    ...overrides
  };
}

function listing() {
  return { listing_id: 4554465743 };
}

test('complete image metadata requires vision and never invents a visual score', () => {
  const result = auditCreativeListing(listing(), Array.from({ length: 10 }, (_, index) => image(index + 1)));

  assert.equal(result.status, 'VISION_REQUIRED');
  assert.equal(result.technical_integrity_score, 100);
  assert.equal(result.visual_quality_score, null);
  assert.equal(result.creative_readiness, null);
  assert.equal(result.ads_eligible, false);
  assert.equal(result.artwork_lock.status, 'SOURCE_NOT_SELECTED');
  assert.equal(result.vision.status, 'NOT_RUN');
  assert.equal(result.required_roles.length, 10);
  assert.ok(result.required_roles.every((role) => role.status === 'UNKNOWN'));
});

test('empty image sets are technically blocked', () => {
  const result = auditCreativeListing(listing(), []);

  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.technical_integrity_score, 0);
  assert.ok(result.findings.some((finding) => finding.code === 'image_set_empty'));
  assert.ok(result.blockers.includes('technical_image_integrity_failed'));
});

test('duplicate image identities are blocked', () => {
  const images = [image(1), image(2, { image_id: 1001 })];
  const result = auditCreativeListing(listing(), images);

  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.findings.some((finding) => finding.code === 'image_identity_invalid'));
});

test('short image sets surface role-capacity work without fabricating coverage', () => {
  const result = auditCreativeListing(listing(), Array.from({ length: 7 }, (_, index) => image(index + 1)));

  assert.equal(result.status, 'VISION_REQUIRED');
  assert.ok(result.findings.some((finding) => finding.code === 'role_capacity_short'));
  assert.ok(result.required_roles.every((role) => role.evidence_image_ids.length === 0));
});

test('manifest hash changes when image identity and rank assignment changes', () => {
  const first = [image(1), image(2)];
  const swapped = [image(1, { rank: 2 }), image(2, { rank: 1 })];

  assert.notEqual(creativeImageManifestHash(first), creativeImageManifestHash(swapped));
});
