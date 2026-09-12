import test from 'node:test';
import assert from 'node:assert/strict';

import {
  patchFromAction,
  snapshotFromListing,
  snapshotHash,
  validateMetadataProposal,
  verifyMetadata
} from '../lib/control-center/metadata.js';

const tags = [
  'canvas wall art',
  'mediterranean art',
  'coastal decor',
  'doorway print',
  'blue wall decor',
  'living room art',
  'italian wall art',
  'summer artwork',
  'ready to hang',
  'framed canvas',
  'travel wall art',
  'villa decor',
  'premium canvas'
];

const original = snapshotFromListing({
  title: 'Mediterranean Door Canvas Wall Art, Coastal Living Room Decor',
  tags,
  description: 'Ready to hang canvas wall art with tracked shipping.',
  last_modified_timestamp: 1234
});

test('valid metadata proposal is deterministic and does not mutate Etsy', () => {
  const result = validateMetadataProposal(original, {
    title: 'Mediterranean Door Canvas Wall Art for Coastal Living Rooms',
    tags,
    description: `${original.description}\n\nSee the size chart before ordering.`
  });

  assert.equal(result.valid, true);
  assert.equal(result.qa.passed, true);
  assert.equal(result.qa.etsy_modified, false);
  assert.deepEqual(result.changed_fields, ['title', 'description']);
});

test('duplicate tags are normalized and an invalid count is blocked', () => {
  const result = validateMetadataProposal(original, {
    tags: [...tags.slice(0, 12), tags[0]]
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('tags_must_be_exactly_13'));
});

test('new unsupported product claims are blocked', () => {
  const result = validateMetadataProposal(original, {
    description: `${original.description} Museum quality archival inks.`
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.includes('unsupported_claim_added:museum quality'));
  assert.ok(result.errors.includes('unsupported_claim_added:archival ink'));
});

test('AI proposals are held to strict claim validation', () => {
  const sourceWithLegacyClaim = {
    ...original,
    description: `${original.description} Museum quality finish.`
  };
  const result = validateMetadataProposal(
    sourceWithLegacyClaim,
    { description: sourceWithLegacyClaim.description },
    { strictClaims: true }
  );

  assert.equal(result.valid, false);
  assert.equal(result.qa.strict_claims, true);
  assert.ok(result.errors.includes('unsupported_claim_present:museum quality'));
});

test('snapshot hash changes when source listing changes', () => {
  const changed = { ...original, title: `${original.title} Premium` };
  assert.notEqual(snapshotHash(original), snapshotHash(changed));
});

test('patch and verification are restricted to declared changed fields', () => {
  const action = {
    changed_fields: ['title', 'tags'],
    proposed: { ...original, title: 'Updated Canvas Wall Art Title for Buyers' }
  };
  const patch = patchFromAction(action);

  assert.deepEqual(Object.keys(patch), ['title', 'tags']);
  assert.equal('description' in patch, false);
  assert.equal(verifyMetadata(action.proposed, action.proposed, action.changed_fields), true);
});
