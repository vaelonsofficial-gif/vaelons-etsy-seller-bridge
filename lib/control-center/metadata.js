import { createHash } from 'node:crypto';

const UNSUPPORTED_CLAIMS = [
  '75+ years',
  'museum quality',
  'museum-quality',
  'waterproof',
  'uv resistant',
  'uv-resistant',
  'archival ink',
  'archival inks',
  'handmade'
];

export function asListingId(value) {
  const id = String(value ?? '').trim();

  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    const error = new Error('Geçersiz listing ID');
    error.status = 400;
    throw error;
  }

  return id;
}

export function normalizeTitle(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function normalizeDescription(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];

  const seen = new Set();
  const normalized = [];

  for (const rawTag of tags) {
    const tag = String(rawTag || '').replace(/\s{2,}/g, ' ').trim();
    const key = tag.toLocaleLowerCase('en-US');

    if (!tag || seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }

  return normalized;
}

export function sameArray(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

export function snapshotFromListing(listing) {
  return {
    title: normalizeTitle(listing?.title),
    tags: normalizeTags(listing?.tags),
    description: normalizeDescription(listing?.description),
    updated_timestamp:
      listing?.updated_timestamp ??
      listing?.last_modified_timestamp ??
      null
  };
}

export function snapshotHash(snapshot) {
  return createHash('sha256')
    .update(JSON.stringify({
      title: normalizeTitle(snapshot?.title),
      tags: normalizeTags(snapshot?.tags),
      description: normalizeDescription(snapshot?.description),
      updated_timestamp: snapshot?.updated_timestamp ?? null
    }))
    .digest('hex');
}

function newlyIntroducedUnsupportedClaims(original, proposed) {
  const before = normalizeDescription(original).toLowerCase();
  const after = normalizeDescription(proposed).toLowerCase();

  return UNSUPPORTED_CLAIMS.filter(
    (claim) => after.includes(claim) && !before.includes(claim)
  );
}

export function validateMetadataProposal(original, input = {}) {
  const proposed = {
    title: input.title === undefined
      ? original.title
      : normalizeTitle(input.title),
    tags: input.tags === undefined
      ? original.tags
      : normalizeTags(input.tags),
    description: input.description === undefined
      ? original.description
      : normalizeDescription(input.description)
  };

  const changeFlags = {
    title: proposed.title !== original.title,
    tags: !sameArray(proposed.tags, original.tags),
    description: proposed.description !== original.description
  };

  const changedFields = Object.entries(changeFlags)
    .filter(([, changed]) => changed)
    .map(([field]) => field);

  const errors = [];
  const warnings = [];

  if (!proposed.title) errors.push('title_empty');
  if (proposed.title.length > 140) errors.push('title_over_140_characters');
  if (proposed.title.length > 0 && proposed.title.length < 20) warnings.push('title_unusually_short');

  if (proposed.tags.length !== 13) errors.push('tags_must_be_exactly_13');

  for (const tag of proposed.tags) {
    if (tag.length > 20) errors.push(`tag_over_20_characters:${tag}`);
    if (!/^[\p{L}\p{Nd}\p{Zs}'\-™©®]+$/u.test(tag)) {
      errors.push(`tag_contains_invalid_characters:${tag}`);
    }
    if (/^['-]|['-]$/.test(tag)) errors.push(`tag_invalid_edge_character:${tag}`);
  }

  if (!proposed.description) errors.push('description_empty');
  if (proposed.description.length > 55000) errors.push('description_over_55000_characters');

  const unsupportedClaims = newlyIntroducedUnsupportedClaims(
    original.description,
    proposed.description
  );

  for (const claim of unsupportedClaims) {
    errors.push(`unsupported_claim_added:${claim}`);
  }

  if (changedFields.length === 0) warnings.push('no_changes');

  return {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    proposed,
    change_flags: changeFlags,
    changed_fields: changedFields,
    qa: {
      passed: errors.length === 0,
      deterministic: true,
      title_valid: Boolean(proposed.title) && proposed.title.length <= 140,
      tags_valid: proposed.tags.length === 13 && !errors.some((item) => item.startsWith('tag_')),
      description_valid: Boolean(proposed.description) && proposed.description.length <= 55000,
      unsupported_claims_added: unsupportedClaims,
      etsy_modified: false
    }
  };
}

export function patchFromAction(action, source = 'proposed') {
  const values = action?.[source] || {};
  const fields = Array.isArray(action?.changed_fields) ? action.changed_fields : [];
  const patch = {};

  if (fields.includes('title')) patch.title = values.title;
  if (fields.includes('tags')) patch.tags = values.tags;
  if (fields.includes('description')) patch.description = values.description;

  return patch;
}

export function verifyMetadata(expected, current, changedFields) {
  if (changedFields.includes('title') && current.title !== expected.title) return false;
  if (changedFields.includes('tags') && !sameArray(current.tags, expected.tags)) return false;
  if (changedFields.includes('description') && current.description !== expected.description) return false;
  return true;
}
