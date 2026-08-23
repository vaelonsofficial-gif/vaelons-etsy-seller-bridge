import express from 'express';
import { Redis } from '@upstash/redis';
import { randomBytes, createHash } from 'node:crypto';

import {
  etsyRequest,
  getShopId
} from './etsy.js';

const router = express.Router();

const PREFIX = 'vaelons:seo:v4';
const PREVIEW_TTL_SECONDS = 24 * 60 * 60;
const HISTORY_LIMIT = 50;

let redisClient = null;

function redis() {
  if (!redisClient) {
    const url =
      process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL;

    const token =
      process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error('Missing Upstash Redis environment variables');
    }

    redisClient = new Redis({
      url,
      token,
      enableTelemetry: false
    });
  }

  return redisClient;
}

function asListingId(value) {
  const id = String(value ?? '').trim();

  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    const error = new Error('Invalid listingId');
    error.status = 400;
    throw error;
  }

  return id;
}

function clampInt(value, min, max) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? Math.round(n) : min;
  return Math.max(min, Math.min(max, safe));
}

function normalizeTitle(value) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeDescription(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .trim();
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const raw of tags) {
    const tag = String(raw || '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    const key = tag.toLowerCase();

    if (!tag || seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(tag);
  }

  return result;
}

function sameArray(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  );
}

function snapshotFromListing(listing) {
  return {
    title: normalizeTitle(listing?.title || ''),
    tags: normalizeTags(listing?.tags || []),
    description: normalizeDescription(listing?.description || ''),
    updated_timestamp:
      listing?.updated_timestamp ??
      listing?.last_modified_timestamp ??
      null
  };
}

function snapshotHash(snapshot) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: snapshot.title,
        tags: snapshot.tags,
        description: snapshot.description,
        updated_timestamp: snapshot.updated_timestamp
      })
    )
    .digest('hex');
}

function previewKey(token) {
  return `${PREFIX}:preview:${token}`;
}

function stateKey(listingId) {
  return `${PREFIX}:listing:${listingId}`;
}

function historyKey(listingId) {
  return `${PREFIX}:history:${listingId}`;
}

async function setJson(key, value, options = {}) {
  return redis().set(key, JSON.stringify(value), options);
}

async function getJson(key) {
  const raw = await redis().get(key);

  if (raw == null) {
    return null;
  }

  if (typeof raw === 'object') {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function addHistory(listingId, event) {
  const payload = JSON.stringify({
    ...event,
    recorded_at: Date.now()
  });

  await redis().lpush(historyKey(listingId), payload);
  await redis().ltrim(historyKey(listingId), 0, HISTORY_LIMIT - 1);
}

async function latestHistory(listingId) {
  const rows = await redis().lrange(historyKey(listingId), 0, 9);

  return rows
    .map((row) => {
      if (typeof row === 'object') {
        return row;
      }

      try {
        return JSON.parse(row);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function validatePreparedSeo(original, input) {
  const proposedTitle =
    input.proposed_title === undefined
      ? original.title
      : normalizeTitle(input.proposed_title);

  const proposedTags =
    input.proposed_tags === undefined
      ? original.tags
      : normalizeTags(input.proposed_tags);

  const proposedDescription =
    input.proposed_description === undefined
      ? original.description
      : normalizeDescription(input.proposed_description);

  const changeTitle = proposedTitle !== original.title;
  const changeTags = !sameArray(proposedTags, original.tags);
  const changeDescription = proposedDescription !== original.description;

  const errors = [];

  if (!proposedTitle) {
    errors.push('title_empty');
  }

  if (proposedTitle.length > 140) {
    errors.push('title_over_140_characters');
  }

  if (proposedTags.length !== 13) {
    errors.push('tags_must_be_exactly_13');
  }

  for (const tag of proposedTags) {
    if (tag.length > 20) {
      errors.push(`tag_over_20_characters:${tag}`);
    }

    if (!/^[\p{L}\p{Nd}\p{Zs}'\-™©®]+$/u.test(tag)) {
      errors.push(`tag_contains_invalid_characters:${tag}`);
    }

    if (/^['-]|['-]$/.test(tag)) {
      errors.push(`tag_invalid_edge_character:${tag}`);
    }
  }

  if (!proposedDescription) {
    errors.push('description_empty');
  }

  const changedFields = [];

  if (changeTitle) {
    changedFields.push('title');
  }

  if (changeTags) {
    changedFields.push('tags');
  }

  if (changeDescription) {
    changedFields.push('description');
  }

  return {
    valid: errors.length === 0,
    errors,
    proposed: {
      title: proposedTitle,
      tags: proposedTags,
      description: proposedDescription
    },
    change_flags: {
      change_title: changeTitle,
      change_tags: changeTags,
      change_description: changeDescription
    },
    changed_fields: changedFields,
    qa: {
      passed: errors.length === 0,
      deterministic: true,
      title_valid: Boolean(proposedTitle) && proposedTitle.length <= 140,
      tags_valid:
        proposedTags.length === 13 &&
        !errors.some((item) => item.startsWith('tag_')),
      description_valid: Boolean(proposedDescription),
      no_backend_openai_call: true
    }
  };
}

async function savePreview(payload) {
  const token = randomBytes(24).toString('base64url');
  const value = {
    ...payload,
    token,
    created_at: Date.now()
  };

  await Promise.all([
    setJson(previewKey(token), value, {
      ex: PREVIEW_TTL_SECONDS
    }),
    setJson(
      stateKey(payload.listing_id),
      {
        status: 'preview_ready',
        preview_token: token,
        original_hash: payload.original_hash,
        created_at: value.created_at,
        changed_fields: payload.changed_fields,
        qa: payload.qa
      },
      {
        ex: PREVIEW_TTL_SECONDS
      }
    )
  ]);

  return value;
}

function patchBodyFromPreview(preview) {
  const body = {};

  if (preview.change_flags.change_title) {
    body.title = preview.proposed.title;
  }

  if (preview.change_flags.change_tags) {
    body.tags = preview.proposed.tags;
  }

  if (preview.change_flags.change_description) {
    body.description = preview.proposed.description;
  }

  return body;
}

function verifyPublished(expected, current, flags) {
  if (flags.change_title && current.title !== expected.title) {
    return false;
  }

  if (flags.change_tags && !sameArray(current.tags, expected.tags)) {
    return false;
  }

  if (
    flags.change_description &&
    current.description !== expected.description
  ) {
    return false;
  }

  return true;
}

function auditListing(listing) {
  const title = normalizeTitle(listing?.title || '');
  const tags = normalizeTags(listing?.tags || []);
  const description = normalizeDescription(listing?.description || '');

  const issues = [];
  const titleWords = title ? title.split(/\s+/).length : 0;

  if (!title) {
    issues.push('title_empty');
  }

  if (title.length > 140) {
    issues.push('title_over_140_characters');
  }

  if (titleWords > 18) {
    issues.push('title_long_for_mobile_readability');
  }

  if (tags.length !== 13) {
    issues.push('tag_count_not_13');
  }

  if (tags.some((tag) => tag.length > 20)) {
    issues.push('tag_over_20_characters');
  }

  if (!description) {
    issues.push('description_empty');
  }

  return {
    listing_id: Number(listing?.listing_id || 0) || null,
    exact_title: title,
    current_tags: tags,
    description_present: Boolean(description),
    title_length: title.length,
    title_word_count: titleWords,
    tag_count: tags.length,
    structural_status: issues.length ? 'needs_review' : 'structurally_valid',
    issues,
    requires_manager_semantic_review: true,
    etsy_modified: false
  };
}

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vaelons-seo-engine',
    version: '4.0.0',
    mode: 'manager_generated_backend_validated',
    backend_openai_required: false,
    thumbnail_worker: false,
    approval_required: 'ONAYLIYORUM',
    rollback_approval_required: 'GERI_AL ONAYLIYORUM',
    safe_flow:
      'read listing -> Manager GPT proposes SEO -> deterministic validation -> preview token -> ONAYLIYORUM -> PATCH -> verify',
    etsy_modified: false
  });
});

router.get('/listings', async (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit || 50, 1, 100);
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const state = String(req.query.state || 'active');
    const shopId = await getShopId();

    const data = await etsyRequest(`/shops/${shopId}/listings`, {
      params: {
        state,
        limit,
        offset
      }
    });

    const results = Array.isArray(data?.results) ? data.results : [];

    res.json({
      count: Number(data?.count ?? results.length),
      limit,
      offset,
      results: results.map((listing) => ({
        listing_id: Number(listing?.listing_id),
        title: normalizeTitle(listing?.title || ''),
        tags: normalizeTags(listing?.tags || []),
        description: normalizeDescription(listing?.description || ''),
        state: listing?.state || null,
        updated_timestamp:
          listing?.updated_timestamp ??
          listing?.last_modified_timestamp ??
          null
      })),
      etsy_modified: false
    });
  } catch (error) {
    next(error);
  }
});

router.post('/scan', async (req, res, next) => {
  const startedAt = Date.now();

  try {
    const limit = clampInt(req.body?.limit ?? req.query?.limit ?? 20, 1, 100);
    const offset = Math.max(
      0,
      Number(req.body?.offset ?? req.query?.offset ?? 0) || 0
    );
    const state = String(req.body?.state ?? req.query?.state ?? 'active');
    const shopId = await getShopId();

    const page = await etsyRequest(`/shops/${shopId}/listings`, {
      params: {
        state,
        limit,
        offset
      }
    });

    const listings = Array.isArray(page?.results) ? page.results : [];
    const totalCount = Number(page?.count ?? listings.length);
    const results = listings.map(auditListing);
    const nextOffset = offset + listings.length;
    const hasMore = listings.length > 0 && nextOffset < totalCount;

    res.json({
      ok: true,
      action: 'seo_structural_scan_complete',
      mode: 'no_backend_openai',
      state,
      total_count: totalCount,
      offset,
      limit,
      processed_count: results.length,
      structurally_valid_count: results.filter(
        (item) => item.structural_status === 'structurally_valid'
      ).length,
      needs_review_count: results.filter(
        (item) => item.structural_status === 'needs_review'
      ).length,
      next_offset: hasMore ? nextOffset : null,
      has_more: hasMore,
      duration_ms: Date.now() - startedAt,
      results,
      publish_performed: false,
      etsy_modified: false
    });
  } catch (error) {
    next(error);
  }
});

router.post('/listings/:listingId/prepare', async (req, res, next) => {
  try {
    const listingId = asListingId(req.params.listingId);
    const listing = await etsyRequest(`/listings/${listingId}`);
    const original = snapshotFromListing(listing);
    const validation = validatePreparedSeo(original, req.body || {});

    if (!validation.valid) {
      await setJson(stateKey(listingId), {
        status: 'blocked_validation',
        checked_at: Date.now(),
        validation_errors: validation.errors
      });

      return res.status(422).json({
        listing_id: Number(listingId),
        exact_title: original.title,
        action: 'blocked',
        status: 'blocked_validation',
        validation_errors: validation.errors,
        qa_passed: false,
        backend_openai_called: false,
        etsy_modified: false
      });
    }

    if (!validation.changed_fields.length) {
      await setJson(stateKey(listingId), {
        status: 'healthy',
        checked_at: Date.now(),
        original_hash: snapshotHash(original)
      });

      return res.json({
        listing_id: Number(listingId),
        exact_title: original.title,
        action: 'keep',
        status: 'healthy',
        reason: 'no_changes_submitted',
        qa_passed: true,
        backend_openai_called: false,
        preview_token: null,
        etsy_modified: false
      });
    }

    const preview = await savePreview({
      listing_id: String(listingId),
      original,
      original_hash: snapshotHash(original),
      proposed: validation.proposed,
      change_flags: validation.change_flags,
      changed_fields: validation.changed_fields,
      reason: String(req.body?.reason || 'manager_generated_seo_proposal'),
      qa: validation.qa
    });

    res.json({
      listing_id: Number(listingId),
      exact_title: original.title,
      action: 'preview_ready',
      status: 'preview_ready',
      original,
      proposed: validation.proposed,
      change_flags: validation.change_flags,
      changed_fields: validation.changed_fields,
      qa_passed: true,
      qa: validation.qa,
      preview_token: preview.token,
      approval_required: 'ONAYLIYORUM',
      backend_openai_called: false,
      etsy_modified: false
    });
  } catch (error) {
    next(error);
  }
});

router.post('/batch-prepare', async (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];

    if (!items.length || items.length > 20) {
      return res.status(400).json({
        error: 'items must contain between 1 and 20 SEO proposals',
        etsy_modified: false
      });
    }

    const results = [];

    for (const item of items) {
      try {
        const listingId = asListingId(item?.listing_id);
        const listing = await etsyRequest(`/listings/${listingId}`);
        const original = snapshotFromListing(listing);
        const validation = validatePreparedSeo(original, item || {});

        if (!validation.valid) {
          await setJson(stateKey(listingId), {
            status: 'blocked_validation',
            checked_at: Date.now(),
            validation_errors: validation.errors
          });

          results.push({
            listing_id: Number(listingId),
            exact_title: original.title,
            action: 'blocked',
            status: 'blocked_validation',
            validation_errors: validation.errors,
            preview_token: null,
            etsy_modified: false
          });
          continue;
        }

        if (!validation.changed_fields.length) {
          results.push({
            listing_id: Number(listingId),
            exact_title: original.title,
            action: 'keep',
            status: 'healthy',
            preview_token: null,
            etsy_modified: false
          });
          continue;
        }

        const preview = await savePreview({
          listing_id: String(listingId),
          original,
          original_hash: snapshotHash(original),
          proposed: validation.proposed,
          change_flags: validation.change_flags,
          changed_fields: validation.changed_fields,
          reason: String(item?.reason || 'manager_generated_seo_proposal'),
          qa: validation.qa
        });

        results.push({
          listing_id: Number(listingId),
          exact_title: original.title,
          action: 'preview_ready',
          status: 'preview_ready',
          changed_fields: validation.changed_fields,
          qa_passed: true,
          preview_token: preview.token,
          etsy_modified: false
        });
      } catch (error) {
        results.push({
          listing_id: Number(item?.listing_id) || null,
          action: 'error',
          status: 'error',
          error: String(error?.message || error || 'Unknown error'),
          preview_token: null,
          etsy_modified: false
        });
      }
    }

    res.json({
      ok: true,
      action: 'seo_batch_prepare_complete',
      processed_count: results.length,
      preview_ready_count: results.filter(
        (item) => item.status === 'preview_ready'
      ).length,
      healthy_count: results.filter((item) => item.status === 'healthy').length,
      blocked_count: results.filter(
        (item) => item.status === 'blocked_validation'
      ).length,
      error_count: results.filter((item) => item.status === 'error').length,
      results,
      approval_required: 'ONAYLIYORUM',
      backend_openai_called: false,
      etsy_modified: false
    });
  } catch (error) {
    next(error);
  }
});

router.get('/listings/:listingId/status', async (req, res, next) => {
  try {
    const listingId = asListingId(req.params.listingId);

    res.json({
      listing_id: Number(listingId),
      state: await getJson(stateKey(listingId)),
      recent_history: await latestHistory(listingId),
      backend_openai_called: false,
      etsy_modified: false
    });
  } catch (error) {
    next(error);
  }
});

router.post('/listings/:listingId/publish', async (req, res, next) => {
  let etsyModified = false;

  try {
    const listingId = asListingId(req.params.listingId);
    const approval = String(req.body?.approval || '').trim();
    const token = String(req.body?.preview_token || '').trim();

    if (approval !== 'ONAYLIYORUM') {
      return res.status(400).json({
        error: 'Exact approval text ONAYLIYORUM is required',
        etsy_modified: false
      });
    }

    const preview = await getJson(previewKey(token));

    if (!preview) {
      return res.status(404).json({
        error: 'SEO preview not found or expired',
        etsy_modified: false
      });
    }

    if (String(preview.listing_id) !== listingId) {
      return res.status(409).json({
        error: 'Preview token belongs to another listing',
        etsy_modified: false
      });
    }

    if (preview?.qa?.passed !== true) {
      return res.status(409).json({
        error: 'SEO preview did not pass deterministic validation',
        etsy_modified: false
      });
    }

    const currentListing = await etsyRequest(`/listings/${listingId}`);
    const current = snapshotFromListing(currentListing);

    if (snapshotHash(current) !== preview.original_hash) {
      return res.status(409).json({
        error:
          'Listing changed after SEO preview was created. Generate a fresh preview.',
        etsy_modified: false
      });
    }

    const body = patchBodyFromPreview(preview);

    if (!Object.keys(body).length) {
      return res.status(409).json({
        error: 'Preview contains no approved SEO changes',
        etsy_modified: false
      });
    }

    await etsyRequest(`/shops/${await getShopId()}/listings/${listingId}`, {
      method: 'PATCH',
      body
    });

    etsyModified = true;

    const verifiedListing = await etsyRequest(`/listings/${listingId}`);
    const verified = snapshotFromListing(verifiedListing);
    const publishedOk = verifyPublished(
      preview.proposed,
      verified,
      preview.change_flags
    );

    await addHistory(listingId, {
      type: 'seo_publish',
      success: publishedOk,
      preview_token: token,
      before: preview.original,
      after_expected: preview.proposed,
      after_verified: verified,
      change_flags: preview.change_flags,
      qa: preview.qa
    });

    await setJson(stateKey(listingId), {
      status: publishedOk ? 'published' : 'manual_attention',
      published_at: Date.now(),
      preview_token: token,
      verified: publishedOk,
      current_hash: snapshotHash(verified)
    });

    res.status(publishedOk ? 200 : 409).json({
      success: publishedOk,
      listing_id: Number(listingId),
      action: publishedOk ? 'published' : 'manual_attention',
      changed_fields: Object.keys(body),
      before: preview.original,
      after: verified,
      verified: publishedOk,
      backend_openai_called: false,
      etsy_modified: true
    });
  } catch (error) {
    error.etsyModified = etsyModified;
    next(error);
  }
});

router.post('/listings/:listingId/rollback', async (req, res, next) => {
  let etsyModified = false;

  try {
    const listingId = asListingId(req.params.listingId);
    const approval = String(req.body?.approval || '').trim();

    if (approval !== 'GERI_AL ONAYLIYORUM') {
      return res.status(400).json({
        error: 'Exact approval text GERI_AL ONAYLIYORUM is required',
        etsy_modified: false
      });
    }

    const history = await latestHistory(listingId);
    const lastPublish = history.find(
      (item) => item?.type === 'seo_publish' && item?.success === true
    );

    if (!lastPublish) {
      return res.status(404).json({
        error: 'No successful SEO publish event available for rollback',
        etsy_modified: false
      });
    }

    const currentListing = await etsyRequest(`/listings/${listingId}`);
    const current = snapshotFromListing(currentListing);

    if (snapshotHash(current) !== snapshotHash(lastPublish.after_verified)) {
      return res.status(409).json({
        error:
          'Listing changed after the SEO publish. Automatic rollback is blocked.',
        etsy_modified: false
      });
    }

    await etsyRequest(`/shops/${await getShopId()}/listings/${listingId}`, {
      method: 'PATCH',
      body: {
        title: lastPublish.before.title,
        tags: lastPublish.before.tags,
        description: lastPublish.before.description
      }
    });

    etsyModified = true;

    const verifiedListing = await etsyRequest(`/listings/${listingId}`);
    const verified = snapshotFromListing(verifiedListing);
    const rollbackOk =
      verified.title === lastPublish.before.title &&
      sameArray(verified.tags, lastPublish.before.tags) &&
      verified.description === lastPublish.before.description;

    await addHistory(listingId, {
      type: 'seo_rollback',
      success: rollbackOk,
      restored: lastPublish.before,
      verified
    });

    await setJson(stateKey(listingId), {
      status: rollbackOk ? 'rolled_back' : 'manual_attention',
      rolled_back_at: Date.now(),
      verified: rollbackOk,
      current_hash: snapshotHash(verified)
    });

    res.status(rollbackOk ? 200 : 409).json({
      success: rollbackOk,
      listing_id: Number(listingId),
      action: rollbackOk ? 'rolled_back' : 'manual_attention',
      restored: verified,
      backend_openai_called: false,
      etsy_modified: true
    });
  } catch (error) {
    error.etsyModified = etsyModified;
    next(error);
  }
});

router.use((error, _req, res, _next) => {
  console.error('SEO engine error:', error);

  res.status(error.status || 500).json({
    error: error.message || 'internal_error',
    details: error.details || null,
    backend_openai_called: false,
    etsy_modified: error.etsyModified === true
  });
});

export default router;
