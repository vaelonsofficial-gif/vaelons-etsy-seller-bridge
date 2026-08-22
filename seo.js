import express from 'express';
import OpenAI from 'openai';
import { Redis } from '@upstash/redis';
import { randomBytes, createHash } from 'node:crypto';

import {
  etsyRequest,
  getShopId
} from './etsy.js';

const router = express.Router();

const PREFIX = 'vaelons:seo:v1';
const PREVIEW_TTL_SECONDS = 24 * 60 * 60;
const HISTORY_LIMIT = 50;

const SEO_MODEL =
  process.env.OPENAI_SEO_MODEL ||
  process.env.OPENAI_QA_MODEL ||
  'gpt-5.6-luna';

let openaiClient = null;
let redisClient = null;


/* =========================================================
   CLIENTS
========================================================= */

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`
    );
  }

  return value;
}

function openai() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: required(
        'VAELONS_OPENAI_API_KEY'
      )
    });
  }

  return openaiClient;
}

function redis() {
  if (!redisClient) {
    const url =
      process.env
        .UPSTASH_REDIS_REST_KV_REST_API_URL ||
      process.env
        .UPSTASH_REDIS_REST_URL;

    const token =
      process.env
        .UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
      process.env
        .UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        'Missing Upstash Redis environment variables'
      );
    }

    redisClient = new Redis({
      url,
      token,
      enableTelemetry: false
    });
  }

  return redisClient;
}


/* =========================================================
   AUTH
========================================================= */

function bridgeAuth(req, res, next) {
  const auth =
    req.get('authorization') ||
    '';

  const key =
    process.env.BRIDGE_API_KEY ||
    '';

  if (
    !key ||
    auth !== `Bearer ${key}`
  ) {
    return res
      .status(401)
      .json({
        error: 'unauthorized',
        etsy_modified: false
      });
  }

  next();
}


/* =========================================================
   BASIC HELPERS
========================================================= */

function asListingId(value) {
  const id =
    String(value || '')
      .trim();

  if (!/^\d+$/.test(id)) {
    const err =
      new Error(
        'Invalid listingId'
      );

    err.status = 400;

    throw err;
  }

  return id;
}

function previewKey(token) {
  return (
    `${PREFIX}:preview:${token}`
  );
}

function stateKey(listingId) {
  return (
    `${PREFIX}:listing:${listingId}`
  );
}

function historyKey(listingId) {
  return (
    `${PREFIX}:history:${listingId}`
  );
}

async function setJson(
  key,
  value,
  options = {}
) {
  return redis().set(
    key,
    JSON.stringify(value),
    options
  );
}

async function getJson(key) {
  const raw =
    await redis().get(key);

  if (raw == null) {
    return null;
  }

  if (
    typeof raw ===
    'object'
  ) {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}


/* =========================================================
   NORMALIZATION
========================================================= */

function normalizeTitle(value) {
  return String(value || '')
    .replace(
      /[\r\n\t]+/g,
      ' '
    )
    .replace(
      /\s{2,}/g,
      ' '
    )
    .trim();
}

function normalizeDescription(value) {
  return String(value || '')
    .replace(
      /\r\n/g,
      '\n'
    )
    .trim();
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) {
    return [];
  }

  const seen =
    new Set();

  const result = [];

  for (const raw of tags) {
    const tag =
      String(raw || '')
        .replace(
          /\s{2,}/g,
          ' '
        )
        .trim();

    if (!tag) {
      continue;
    }

    const key =
      tag.toLocaleLowerCase(
        'en-US'
      );

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);

    result.push(tag);
  }

  return result;
}


/* =========================================================
   VALIDATION
========================================================= */

function validateProposal(proposal) {
  const errors = [];

  const title =
    normalizeTitle(
      proposal.proposed_title
    );

  const tags =
    normalizeTags(
      proposal.proposed_tags
    );

  const description =
    normalizeDescription(
      proposal.proposed_description
    );

  if (!title) {
    errors.push(
      'title_empty'
    );
  }

  if (
    title.length >
    140
  ) {
    errors.push(
      'title_over_140_characters'
    );
  }

  if (
    tags.length !==
    13
  ) {
    errors.push(
      'tags_must_be_exactly_13'
    );
  }

  for (const tag of tags) {
    if (
      tag.length >
      20
    ) {
      errors.push(
        `tag_over_20_characters:${tag}`
      );
    }

    if (
      !/^[\p{L}\p{Nd}\p{Zs}'\-™©®]+$/u
        .test(tag)
    ) {
      errors.push(
        `tag_contains_invalid_characters:${tag}`
      );
    }

    if (
      /^['-]|['-]$/
        .test(tag)
    ) {
      errors.push(
        `tag_invalid_edge_character:${tag}`
      );
    }
  }

  if (
    proposal.change_description ===
      true &&
    !description
  ) {
    errors.push(
      'description_empty'
    );
  }

  return {
    valid:
      errors.length ===
      0,

    errors,

    normalized: {
      title,
      tags,
      description
    }
  };
}


/* =========================================================
   LISTING SNAPSHOT
========================================================= */

function snapshotFromListing(
  listing
) {
  return {
    title:
      normalizeTitle(
        listing?.title ||
        ''
      ),

    tags:
      normalizeTags(
        listing?.tags ||
        []
      ),

    description:
      normalizeDescription(
        listing?.description ||
        ''
      ),

    updated_timestamp:
      listing
        ?.updated_timestamp ??
      listing
        ?.last_modified_timestamp ??
      null
  };
}

function snapshotHash(snapshot) {
  return createHash(
    'sha256'
  )
    .update(
      JSON.stringify({
        title:
          snapshot.title,

        tags:
          snapshot.tags,

        description:
          snapshot.description,

        updated_timestamp:
          snapshot
            .updated_timestamp
      })
    )
    .digest('hex');
}

function sameArray(a, b) {
  if (
    !Array.isArray(a) ||
    !Array.isArray(b) ||
    a.length !==
      b.length
  ) {
    return false;
  }

  return a.every(
    (
      value,
      index
    ) =>
      String(value) ===
      String(b[index])
  );
}


/* =========================================================
   SEO PROMPT
========================================================= */

function buildProposalPrompt(
  listing,
  original
) {
  const compactDescription =
    original
      .description
      .slice(
        0,
        12000
      );

  return `
You are the SEO optimization engine for an Etsy seller.

Your job is to improve ONLY the listing title, tags, and description using the facts already present in the listing.

CURRENT LISTING

Title:
${original.title}

Tags:
${JSON.stringify(original.tags)}

Description:
${compactDescription}

Additional listing facts:
- taxonomy_id: ${listing?.taxonomy_id ?? 'unknown'}
- listing_type: ${listing?.listing_type ?? 'unknown'}
- materials: ${JSON.stringify(listing?.materials || [])}
- is_personalizable: ${Boolean(listing?.is_personalizable)}
- is_customizable: ${Boolean(listing?.is_customizable)}

NON-NEGOTIABLE SAFETY RULES

- Do not invent materials.
- Do not invent sizes.
- Do not invent colors.
- Do not invent locations.
- Do not invent production methods.
- Do not invent shipping promises.
- Do not invent personalization options.
- Do not invent discounts.
- Do not invent guarantees.
- Do not invent product features.
- Do not remove important factual product details.
- Do not remove size information.
- Do not remove shipping information.
- Do not remove personalization instructions.
- Do not remove policies or disclaimers.
- Do not change what the product actually is.
- Do not use competitor brand names.
- Do not use irrelevant trending keywords.

ETSY TITLE RULES

- Maximum 140 characters.
- Prefer fewer than 15 words when possible.
- Clearly state what the item is near the beginning.
- Lead with the strongest descriptive buyer-facing phrase.
- Keep it natural and readable on mobile.
- Avoid keyword stuffing.
- Avoid repeated phrases.
- Avoid subjective filler.
- Avoid unnecessary gift or occasion phrases unless essential to the item.

ETSY TAG RULES

- Return exactly 13 unique tags.
- Each tag maximum 20 characters.
- Prefer natural multi-word buyer phrases.
- Diversify buyer intent.
- Do not repeat nearly identical phrases.
- Use only facts supported by the listing.

DESCRIPTION RULES

- Improve clarity and search usefulness while preserving all factual and operational information.
- Put a concise buyer-friendly opening near the top.
- Naturally include relevant search language without stuffing.
- Preserve important existing factual sections and meaning.

Be conservative.

If the current field is already strong, keep it unchanged and set the corresponding change flag to false.
`.trim();
}


/* =========================================================
   AI SEO PROPOSAL
========================================================= */

async function generateProposal(
  listing,
  original
) {
  const schema = {
    type: 'object',

    additionalProperties:
      false,

    required: [
      'proposed_title',
      'proposed_tags',
      'proposed_description',
      'change_title',
      'change_tags',
      'change_description',
      'confidence',
      'risk_level',
      'reason',
      'keyword_strategy'
    ],

    properties: {
      proposed_title: {
        type: 'string'
      },

      proposed_tags: {
        type: 'array',

        items: {
          type: 'string'
        }
      },

      proposed_description: {
        type: 'string'
      },

      change_title: {
        type: 'boolean'
      },

      change_tags: {
        type: 'boolean'
      },

      change_description: {
        type: 'boolean'
      },

      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },

      risk_level: {
        type: 'string',

        enum: [
          'low',
          'medium',
          'high'
        ]
      },

      reason: {
        type: 'string'
      },

      keyword_strategy: {
        type: 'array',

        items: {
          type: 'string'
        }
      }
    }
  };

  const response =
    await openai()
      .responses
      .create({
        model:
          SEO_MODEL,

        store:
          false,

        input: [
          {
            role:
              'user',

            content: [
              {
                type:
                  'input_text',

                text:
                  buildProposalPrompt(
                    listing,
                    original
                  )
              }
            ]
          }
        ],

        text: {
          format: {
            type:
              'json_schema',

            name:
              'etsy_seo_proposal',

            strict:
              true,

            schema
          }
        }
      });

  return JSON.parse(
    response.output_text ||
    '{}'
  );
}


/* =========================================================
   SEO QUALITY GATE
========================================================= */

async function qualityCheck(
  original,
  proposal,
  normalized
) {
  const schema = {
    type: 'object',

    additionalProperties:
      false,

    required: [
      'pass',
      'title_clear',
      'tags_valid',
      'description_preserves_facts',
      'no_invented_facts',
      'keyword_stuffing',
      'confidence',
      'reason'
    ],

    properties: {
      pass: {
        type: 'boolean'
      },

      title_clear: {
        type: 'boolean'
      },

      tags_valid: {
        type: 'boolean'
      },

      description_preserves_facts: {
        type: 'boolean'
      },

      no_invented_facts: {
        type: 'boolean'
      },

      keyword_stuffing: {
        type: 'boolean'
      },

      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },

      reason: {
        type: 'string'
      }
    }
  };

  const response =
    await openai()
      .responses
      .create({
        model:
          SEO_MODEL,

        store:
          false,

        input: [
          {
            role:
              'user',

            content: [
              {
                type:
                  'input_text',

                text:
`Act as a strict safety reviewer for an Etsy SEO update.

Compare the CURRENT listing fields against the PROPOSED fields.

CURRENT TITLE:
${original.title}

CURRENT TAGS:
${JSON.stringify(original.tags)}

CURRENT DESCRIPTION:
${original.description}

PROPOSED TITLE:
${normalized.title}

PROPOSED TAGS:
${JSON.stringify(normalized.tags)}

PROPOSED DESCRIPTION:
${normalized.description}

CHANGE FLAGS:
${JSON.stringify({
  change_title:
    proposal.change_title,

  change_tags:
    proposal.change_tags,

  change_description:
    proposal.change_description
})}

PASS only if:
- the proposal stays faithful to facts present in the current listing
- title is clear and natural
- all 13 tags are valid and relevant
- description preserves important facts
- no keyword stuffing exists
- no product information was invented`
              }
            ]
          }
        ],

        text: {
          format: {
            type:
              'json_schema',

            name:
              'etsy_seo_quality_gate',

            strict:
              true,

            schema
          }
        }
      });

  const result =
    JSON.parse(
      response.output_text ||
      '{}'
    );

  const passed =
    result.pass ===
      true &&
    result.title_clear ===
      true &&
    result.tags_valid ===
      true &&
    result.description_preserves_facts ===
      true &&
    result.no_invented_facts ===
      true &&
    result.keyword_stuffing ===
      false &&
    Number(
      result.confidence ||
      0
    ) >=
      0.75;

  return {
    ...result,
    passed
  };
}


/* =========================================================
   PREVIEW STORAGE
========================================================= */

async function savePreview(
  preview
) {
  const token =
    randomBytes(24)
      .toString(
        'base64url'
      );

  const value = {
    ...preview,

    token,

    created_at:
      Date.now()
  };

  await Promise.all([
    setJson(
      previewKey(token),
      value,
      {
        ex:
          PREVIEW_TTL_SECONDS
      }
    ),

    setJson(
      stateKey(
        preview.listing_id
      ),
      {
        status:
          'preview_ready',

        preview_token:
          token,

        original_hash:
          preview.original_hash,

        created_at:
          value.created_at,

        qa:
          preview.qa
      }
    )
  ]);

  return value;
}


/* =========================================================
   HISTORY
========================================================= */

async function addHistory(
  listingId,
  event
) {
  const payload =
    JSON.stringify({
      ...event,

      recorded_at:
        Date.now()
    });

  await redis().lpush(
    historyKey(listingId),
    payload
  );

  await redis().ltrim(
    historyKey(listingId),
    0,
    HISTORY_LIMIT - 1
  );
}

async function latestHistory(
  listingId
) {
  const rows =
    await redis().lrange(
      historyKey(listingId),
      0,
      9
    );

  return rows
    .map(
      (row) => {
        if (
          typeof row ===
          'object'
        ) {
          return row;
        }

        try {
          return JSON.parse(row);
        } catch {
          return null;
        }
      }
    )
    .filter(Boolean);
}


/* =========================================================
   PATCH BODY
========================================================= */

function patchBodyFromPreview(
  preview
) {
  const body = {};

  if (
    preview
      .proposal
      .change_title ===
    true
  ) {
    body.title =
      preview
        .proposed
        .title;
  }

  if (
    preview
      .proposal
      .change_tags ===
    true
  ) {
    body.tags =
      preview
        .proposed
        .tags;
  }

  if (
    preview
      .proposal
      .change_description ===
    true
  ) {
    body.description =
      preview
        .proposed
        .description;
  }

  return body;
}

function verifyPublished(
  expected,
  current,
  flags
) {
  if (
    flags.change_title ===
      true &&
    current.title !==
      expected.title
  ) {
    return false;
  }

  if (
    flags.change_tags ===
      true &&
    !sameArray(
      current.tags,
      expected.tags
    )
  ) {
    return false;
  }

  if (
    flags.change_description ===
      true &&
    current.description !==
      expected.description
  ) {
    return false;
  }

  return true;
}


/* =========================================================
   AUTH
========================================================= */

router.use(
  bridgeAuth
);


/* =========================================================
   HEALTH
========================================================= */

router.get(
  '/health',
  (_req, res) => {
    res.json({
      ok:
        true,

      service:
        'vaelons-seo-engine',

      version:
        '1.0.0',

      model:
        SEO_MODEL,

      approval_required:
        'ONAYLIYORUM',

      safe_flow:
        'prepare -> QA -> preview -> approval -> PATCH -> verify'
    });
  }
);


/* =========================================================
   PREPARE SEO
========================================================= */

router.post(
  '/listings/:listingId/prepare',
  async (
    req,
    res,
    next
  ) => {
    try {
      const listingId =
        asListingId(
          req.params
            .listingId
        );

      const listing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const original =
        snapshotFromListing(
          listing
        );

      const proposal =
        await generateProposal(
          listing,
          original
        );

      const validation =
        validateProposal(
          proposal
        );

      if (
        !validation.valid
      ) {
        await setJson(
          stateKey(listingId),
          {
            status:
              'blocked_validation',

            checked_at:
              Date.now(),

            validation_errors:
              validation.errors
          }
        );

        return res
          .status(422)
          .json({
            listing_id:
              Number(listingId),

            exact_title:
              original.title,

            action:
              'blocked',

            reason:
              'seo_proposal_failed_validation',

            validation_errors:
              validation.errors,

            etsy_modified:
              false
          });
      }

      const normalized =
        validation.normalized;

      if (
        proposal
          .change_title !==
        true
      ) {
        normalized.title =
          original.title;
      }

      if (
        proposal
          .change_tags !==
        true
      ) {
        normalized.tags =
          original.tags;
      }

      if (
        proposal
          .change_description !==
        true
      ) {
        normalized.description =
          original.description;
      }

      const noChanges =
        normalized.title ===
          original.title &&
        sameArray(
          normalized.tags,
          original.tags
        ) &&
        normalized.description ===
          original.description;

      if (noChanges) {
        await setJson(
          stateKey(listingId),
          {
            status:
              'healthy',

            checked_at:
              Date.now(),

            original_hash:
              snapshotHash(
                original
              )
          }
        );

        return res.json({
          listing_id:
            Number(listingId),

          exact_title:
            original.title,

          action:
            'keep',

          reason:
            'seo_already_healthy',

          etsy_modified:
            false
        });
      }

      const qa =
        await qualityCheck(
          original,
          proposal,
          normalized
        );

      if (!qa.passed) {
        await setJson(
          stateKey(listingId),
          {
            status:
              'blocked_qa',

            checked_at:
              Date.now(),

            qa
          }
        );

        return res
          .status(422)
          .json({
            listing_id:
              Number(listingId),

            exact_title:
              original.title,

            action:
              'blocked',

            reason:
              'seo_quality_gate_failed',

            qa,

            etsy_modified:
              false
          });
      }

      const preview =
        await savePreview({
          listing_id:
            String(listingId),

          original,

          original_hash:
            snapshotHash(
              original
            ),

          proposed:
            normalized,

          proposal: {
            change_title:
              proposal.change_title ===
              true,

            change_tags:
              proposal.change_tags ===
              true,

            change_description:
              proposal.change_description ===
              true,

            confidence:
              Number(
                proposal.confidence ||
                0
              ),

            risk_level:
              String(
                proposal.risk_level ||
                'medium'
              ),

            reason:
              String(
                proposal.reason ||
                ''
              ),

            keyword_strategy:
              Array.isArray(
                proposal
                  .keyword_strategy
              )
                ? proposal
                    .keyword_strategy
                : []
          },

          qa
        });

      res.json({
        listing_id:
          Number(listingId),

        exact_title:
          original.title,

        action:
          'preview_ready',

        original,

        proposed:
          normalized,

        change_flags:
          preview.proposal,

        qa,

        preview_token:
          preview.token,

        approval_required:
          'ONAYLIYORUM',

        etsy_modified:
          false
      });

    } catch (error) {
      next(error);
    }
  }
);


/* =========================================================
   SEO STATUS
========================================================= */

router.get(
  '/listings/:listingId/status',
  async (
    req,
    res,
    next
  ) => {
    try {
      const listingId =
        asListingId(
          req.params
            .listingId
        );

      res.json({
        listing_id:
          Number(listingId),

        state:
          await getJson(
            stateKey(listingId)
          ),

        recent_history:
          await latestHistory(
            listingId
          ),

        etsy_modified:
          false
      });

    } catch (error) {
      next(error);
    }
  }
);


/* =========================================================
   PUBLISH SEO
========================================================= */

router.post(
  '/listings/:listingId/publish',
  async (
    req,
    res,
    next
  ) => {
    let etsyModified =
      false;

    try {
      const listingId =
        asListingId(
          req.params
            .listingId
        );

      const approval =
        String(
          req.body
            ?.approval ||
          ''
        ).trim();

      const token =
        String(
          req.body
            ?.preview_token ||
          ''
        ).trim();

      if (
        approval !==
        'ONAYLIYORUM'
      ) {
        return res
          .status(400)
          .json({
            error:
              'Exact approval text ONAYLIYORUM is required',

            etsy_modified:
              false
          });
      }

      const preview =
        await getJson(
          previewKey(token)
        );

      if (!preview) {
        return res
          .status(404)
          .json({
            error:
              'SEO preview not found or expired',

            etsy_modified:
              false
          });
      }

      if (
        String(
          preview.listing_id
        ) !==
        listingId
      ) {
        return res
          .status(409)
          .json({
            error:
              'Preview token belongs to another listing',

            etsy_modified:
              false
          });
      }

      if (
        preview
          ?.qa
          ?.passed !==
        true
      ) {
        return res
          .status(409)
          .json({
            error:
              'SEO preview did not pass QA',

            etsy_modified:
              false
          });
      }

      const currentListing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const current =
        snapshotFromListing(
          currentListing
        );

      if (
        snapshotHash(current) !==
        preview.original_hash
      ) {
        return res
          .status(409)
          .json({
            error:
              'Listing changed after SEO preview was created. Generate a fresh preview.',

            etsy_modified:
              false
          });
      }

      const body =
        patchBodyFromPreview(
          preview
        );

      if (
        !Object.keys(body)
          .length
      ) {
        return res
          .status(409)
          .json({
            error:
              'Preview contains no approved SEO changes',

            etsy_modified:
              false
          });
      }

      await etsyRequest(
        `/shops/${await getShopId()}/listings/${listingId}`,
        {
          method:
            'PATCH',

          body
        }
      );

      etsyModified =
        true;

      const verifiedListing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const verified =
        snapshotFromListing(
          verifiedListing
        );

      const publishedOk =
        verifyPublished(
          preview.proposed,
          verified,
          preview.proposal
        );

      const event = {
        type:
          'seo_publish',

        success:
          publishedOk,

        preview_token:
          token,

        before:
          preview.original,

        after_expected:
          preview.proposed,

        after_verified:
          verified,

        change_flags:
          preview.proposal,

        qa:
          preview.qa
      };

      await addHistory(
        listingId,
        event
      );

      await setJson(
        stateKey(listingId),
        {
          status:
            publishedOk
              ? 'published'
              : 'manual_attention',

          published_at:
            Date.now(),

          preview_token:
            token,

          verified:
            publishedOk,

          current_hash:
            snapshotHash(
              verified
            )
        }
      );

      res
        .status(
          publishedOk
            ? 200
            : 409
        )
        .json({
          success:
            publishedOk,

          listing_id:
            Number(
              listingId
            ),

          action:
            publishedOk
              ? 'published'
              : 'manual_attention',

          changed_fields:
            Object.keys(body),

          before:
            preview.original,

          after:
            verified,

          verified:
            publishedOk,

          etsy_modified:
            true
        });

    } catch (error) {
      error.etsyModified =
        etsyModified;

      next(error);
    }
  }
);


/* =========================================================
   ROLLBACK
========================================================= */

router.post(
  '/listings/:listingId/rollback',
  async (
    req,
    res,
    next
  ) => {
    let etsyModified =
      false;

    try {
      const listingId =
        asListingId(
          req.params
            .listingId
        );

      const approval =
        String(
          req.body
            ?.approval ||
          ''
        ).trim();

      if (
        approval !==
        'GERI_AL ONAYLIYORUM'
      ) {
        return res
          .status(400)
          .json({
            error:
              'Exact approval text GERI_AL ONAYLIYORUM is required',

            etsy_modified:
              false
          });
      }

      const history =
        await latestHistory(
          listingId
        );

      const lastPublish =
        history.find(
          (item) =>
            item?.type ===
              'seo_publish' &&
            item?.success ===
              true
        );

      if (!lastPublish) {
        return res
          .status(404)
          .json({
            error:
              'No successful SEO publish event available for rollback',

            etsy_modified:
              false
          });
      }

      const currentListing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const current =
        snapshotFromListing(
          currentListing
        );

      if (
        snapshotHash(current) !==
        snapshotHash(
          lastPublish
            .after_verified
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Listing changed after the SEO publish. Automatic rollback is blocked.',

            etsy_modified:
              false
          });
      }

      await etsyRequest(
        `/shops/${await getShopId()}/listings/${listingId}`,
        {
          method:
            'PATCH',

          body: {
            title:
              lastPublish
                .before
                .title,

            tags:
              lastPublish
                .before
                .tags,

            description:
              lastPublish
                .before
                .description
          }
        }
      );

      etsyModified =
        true;

      const verifiedListing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const verified =
        snapshotFromListing(
          verifiedListing
        );

      const rollbackOk =
        verified.title ===
          lastPublish
            .before
            .title &&
        sameArray(
          verified.tags,
          lastPublish
            .before
            .tags
        ) &&
        verified.description ===
          lastPublish
            .before
            .description;

      await addHistory(
        listingId,
        {
          type:
            'seo_rollback',

          success:
            rollbackOk,

          restored:
            lastPublish.before,

          verified
        }
      );

      await setJson(
        stateKey(listingId),
        {
          status:
            rollbackOk
              ? 'rolled_back'
              : 'manual_attention',

          rolled_back_at:
            Date.now(),

          verified:
            rollbackOk,

          current_hash:
            snapshotHash(
              verified
            )
        }
      );

      res
        .status(
          rollbackOk
            ? 200
            : 409
        )
        .json({
          success:
            rollbackOk,

          listing_id:
            Number(
              listingId
            ),

          action:
            rollbackOk
              ? 'rolled_back'
              : 'manual_attention',

          restored:
            verified,

          etsy_modified:
            true
        });

    } catch (error) {
      error.etsyModified =
        etsyModified;

      next(error);
    }
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

router.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
      'SEO engine error:',
      error
    );

    res
      .status(
        error.status ||
        500
      )
      .json({
        error:
          error.message ||
          'internal_error',

        details:
          error.details ||
          null,

        etsy_modified:
          error
            .etsyModified ===
          true
      });
  }
);


export default router;
