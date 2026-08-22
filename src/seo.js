import express from 'express';
import OpenAI from 'openai';
import sharp from 'sharp';
import { Redis } from '@upstash/redis';
import { randomBytes, createHash } from 'node:crypto';

import {
  etsyRequest,
  getShopId,
  getListingImages
} from './etsy.js';

const router = express.Router();

const PREFIX = 'vaelons:seo:v2';
const PREVIEW_TTL_SECONDS = 24 * 60 * 60;
const HISTORY_LIMIT = 50;

const SECTION_CONFIDENCE_THRESHOLD = 0.8;
const SECTION_CLASSIFY_BATCH = 4;
const SECTION_IMAGE_COUNT = 2;
const SECTION_HYDRATE_CONCURRENCY = 3;

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
    openaiClient =
      new OpenAI({
        apiKey:
          required(
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

    redisClient =
      new Redis({
        url,
        token,
        enableTelemetry:
          false
      });
  }

  return redisClient;
}


/* =========================================================
   AUTH
========================================================= */

function bridgeAuth(
  req,
  res,
  next
) {
  const auth =
    req.get(
      'authorization'
    ) ||
    '';

  const key =
    process.env
      .BRIDGE_API_KEY ||
    '';

  if (
    !key ||
    auth !==
      `Bearer ${key}`
  ) {
    return res
      .status(
        401
      )
      .json({
        error:
          'unauthorized',

        etsy_modified:
          false
      });
  }

  next();
}


/* =========================================================
   BASIC HELPERS
========================================================= */

function asListingId(
  value
) {
  const id =
    String(
      value ||
      ''
    ).trim();

  if (
    !/^\d+$/.test(
      id
    )
  ) {
    const err =
      new Error(
        'Invalid listingId'
      );

    err.status =
      400;

    throw err;
  }

  return id;
}

function clampInt(
  value,
  min,
  max
) {
  const n =
    Number(
      value
    );

  const safe =
    Number.isFinite(
      n
    )
      ? Math.round(
          n
        )
      : min;

  return Math.max(
    min,
    Math.min(
      max,
      safe
    )
  );
}

function normalizeTitle(
  value
) {
  return String(
    value ||
    ''
  )
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

function normalizeDescription(
  value
) {
  return String(
    value ||
    ''
  )
    .replace(
      /\r\n/g,
      '\n'
    )
    .trim();
}

function normalizeTags(
  tags
) {
  if (
    !Array.isArray(
      tags
    )
  ) {
    return [];
  }

  const seen =
    new Set();

  const result =
    [];

  for (
    const raw of
    tags
  ) {
    const tag =
      String(
        raw ||
        ''
      )
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

    if (
      seen.has(
        key
      )
    ) {
      continue;
    }

    seen.add(
      key
    );

    result.push(
      tag
    );
  }

  return result;
}

function sameArray(
  a,
  b
) {
  if (
    !Array.isArray(
      a
    ) ||
    !Array.isArray(
      b
    ) ||
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
      String(
        value
      ) ===
      String(
        b[index]
      )
  );
}

function getListingSectionId(
  listing
) {
  const raw =
    listing
      ?.shop_section_id ??
    listing
      ?.section_id ??
    null;

  if (
    raw == null ||
    raw ===
      '' ||
    Number(
      raw
    ) <=
      0
  ) {
    return null;
  }

  return Number(
    raw
  );
}

function getImageUrl(
  image
) {
  return (
    image
      ?.url_fullxfull ||
    image
      ?.url_570xN ||
    image
      ?.url_300x300 ||
    image
      ?.url_170x135 ||
    null
  );
}

async function mapWithConcurrency(
  items,
  concurrency,
  mapper
) {
  const results =
    new Array(
      items.length
    );

  let index =
    0;

  async function worker() {
    while (
      true
    ) {
      const current =
        index;

      index +=
        1;

      if (
        current >=
        items.length
      ) {
        return;
      }

      results[
        current
      ] =
        await mapper(
          items[current],
          current
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            concurrency,
            Math.max(
              1,
              items.length
            )
          )
      },
      () =>
        worker()
    )
  );

  return results;
}


/* =========================================================
   REDIS
========================================================= */

function previewKey(
  token
) {
  return (
    `${PREFIX}:preview:${token}`
  );
}

function stateKey(
  listingId
) {
  return (
    `${PREFIX}:listing:${listingId}`
  );
}

function historyKey(
  listingId
) {
  return (
    `${PREFIX}:history:${listingId}`
  );
}

function sectionPreviewKey(
  token
) {
  return (
    `${PREFIX}:section-preview:${token}`
  );
}

async function setJson(
  key,
  value,
  options = {}
) {
  return redis().set(
    key,
    JSON.stringify(
      value
    ),
    options
  );
}

async function getJson(
  key
) {
  const raw =
    await redis().get(
      key
    );

  if (
    raw ==
    null
  ) {
    return null;
  }

  if (
    typeof raw ===
    'object'
  ) {
    return raw;
  }

  try {
    return JSON.parse(
      raw
    );

  } catch {
    return null;
  }
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
        listing
          ?.title ||
        ''
      ),

    tags:
      normalizeTags(
        listing
          ?.tags ||
        []
      ),

    description:
      normalizeDescription(
        listing
          ?.description ||
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

function snapshotHash(
  snapshot
) {
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
    .digest(
      'hex'
    );
}


/* =========================================================
   SEO VALIDATION
========================================================= */

function validateProposal(
  proposal
) {
  const errors =
    [];

  const title =
    normalizeTitle(
      proposal
        .proposed_title
    );

  const tags =
    normalizeTags(
      proposal
        .proposed_tags
    );

  const description =
    normalizeDescription(
      proposal
        .proposed_description
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

  for (
    const tag of
    tags
  ) {
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
        .test(
          tag
        )
    ) {
      errors.push(
        `tag_contains_invalid_characters:${tag}`
      );
    }

    if (
      /^['-]|['-]$/
        .test(
          tag
        )
    ) {
      errors.push(
        `tag_invalid_edge_character:${tag}`
      );
    }
  }

  if (
    proposal
      .change_description ===
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

Improve ONLY the listing title, tags, and description using facts already present in the listing.

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

SAFETY RULES

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
- Do not remove important factual details.
- Do not remove shipping information.
- Do not remove personalization instructions.
- Do not remove policies or disclaimers.
- Do not change what the product actually is.
- Do not use competitor brand names.
- Do not use irrelevant trending keywords.

TITLE

- Maximum 140 characters.
- Prefer fewer than 15 words when possible.
- Clearly state what the item is near the beginning.
- Lead with the strongest buyer-facing phrase.
- Keep it natural and readable on mobile.
- Avoid keyword stuffing.
- Avoid repeated phrases.
- Avoid subjective filler.

TAGS

- Return exactly 13 unique tags.
- Each tag maximum 20 characters.
- Prefer natural multi-word buyer phrases.
- Diversify buyer intent.
- Do not repeat nearly identical phrases.
- Use only facts supported by the listing.

DESCRIPTION

- Improve clarity and search usefulness.
- Preserve factual and operational information.
- Put a concise buyer-friendly opening near the top.
- Naturally include relevant search language.
- Preserve important sections and meaning.

Be conservative.

If a field is already strong, keep it unchanged and set the corresponding change flag to false.
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
    type:
      'object',

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
        type:
          'string'
      },

      proposed_tags: {
        type:
          'array',

        items: {
          type:
            'string'
        }
      },

      proposed_description: {
        type:
          'string'
      },

      change_title: {
        type:
          'boolean'
      },

      change_tags: {
        type:
          'boolean'
      },

      change_description: {
        type:
          'boolean'
      },

      confidence: {
        type:
          'number',

        minimum:
          0,

        maximum:
          1
      },

      risk_level: {
        type:
          'string',

        enum: [
          'low',
          'medium',
          'high'
        ]
      },

      reason: {
        type:
          'string'
      },

      keyword_strategy: {
        type:
          'array',

        items: {
          type:
            'string'
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
    type:
      'object',

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
        type:
          'boolean'
      },

      title_clear: {
        type:
          'boolean'
      },

      tags_valid: {
        type:
          'boolean'
      },

      description_preserves_facts: {
        type:
          'boolean'
      },

      no_invented_facts: {
        type:
          'boolean'
      },

      keyword_stuffing: {
        type:
          'boolean'
      },

      confidence: {
        type:
          'number',

        minimum:
          0,

        maximum:
          1
      },

      reason: {
        type:
          'string'
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
- proposal stays faithful to existing facts
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
   SEO PREVIEW
========================================================= */

async function savePreview(
  preview
) {
  const token =
    randomBytes(
      24
    ).toString(
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
      previewKey(
        token
      ),
      value,
      {
        ex:
          PREVIEW_TTL_SECONDS
      }
    ),

    setJson(
      stateKey(
        preview
          .listing_id
      ),
      {
        status:
          'preview_ready',

        preview_token:
          token,

        original_hash:
          preview
            .original_hash,

        created_at:
          value
            .created_at,

        qa:
          preview
            .qa
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
    historyKey(
      listingId
    ),
    payload
  );

  await redis().ltrim(
    historyKey(
      listingId
    ),
    0,
    HISTORY_LIMIT -
      1
  );
}

async function latestHistory(
  listingId
) {
  const rows =
    await redis().lrange(
      historyKey(
        listingId
      ),
      0,
      9
    );

  return rows
    .map(
      (
        row
      ) => {
        if (
          typeof row ===
          'object'
        ) {
          return row;
        }

        try {
          return JSON.parse(
            row
          );

        } catch {
          return null;
        }
      }
    )
    .filter(
      Boolean
    );
}


/* =========================================================
   SEO PATCH
========================================================= */

function patchBodyFromPreview(
  preview
) {
  const body =
    {};

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
    flags
      .change_title ===
      true &&
    current.title !==
      expected.title
  ) {
    return false;
  }

  if (
    flags
      .change_tags ===
      true &&
    !sameArray(
      current.tags,
      expected.tags
    )
  ) {
    return false;
  }

  if (
    flags
      .change_description ===
      true &&
    current.description !==
      expected.description
  ) {
    return false;
  }

  return true;
}


/* =========================================================
   ETSY SECTIONS
========================================================= */

async function getShopSections() {
  const shopId =
    await getShopId();

  const data =
    await etsyRequest(
      `/shops/${shopId}/sections`
    );

  const sections =
    Array.isArray(
      data
        ?.results
    )
      ? data.results
      : [];

  return sections
    .map(
      (
        section
      ) => ({
        shop_section_id:
          Number(
            section
              .shop_section_id
          ),

        title:
          String(
            section
              .title ||
            ''
          ).trim(),

        rank:
          Number(
            section
              .rank ??
            0
          ),

        active_listing_count:
          Number(
            section
              .active_listing_count ??
            0
          )
      })
    )
    .filter(
      (
        section
      ) =>
        Number.isFinite(
          section
            .shop_section_id
        ) &&
        section
          .shop_section_id >
        0 &&
        section
          .title
    )
    .sort(
      (
        a,
        b
      ) =>
        a.rank -
        b.rank
    );
}


/* =========================================================
   ACTIVE LISTINGS
========================================================= */

async function fetchAllActiveListings() {
  const shopId =
    await getShopId();

  const results =
    [];

  let offset =
    0;

  let total =
    Infinity;

  while (
    offset <
    total
  ) {
    const data =
      await etsyRequest(
        `/shops/${shopId}/listings`,
        {
          params: {
            state:
              'active',

            limit:
              100,

            offset,

            sort_on:
              'created',

            sort_order:
              'desc'
          }
        }
      );

    const page =
      Array.isArray(
        data
          ?.results
      )
        ? data.results
        : [];

    total =
      Number(
        data
          ?.count ??
        page.length
      );

    results.push(
      ...page
    );

    if (
      !page.length ||
      page.length <
        100
    ) {
      break;
    }

    offset +=
      page.length;
  }

  return results;
}


/* =========================================================
   VISUAL SECTION EVIDENCE
========================================================= */

async function imageToDataUrl(
  url
) {
  if (!url) {
    return null;
  }

  const parsed =
    new URL(
      url
    );

  if (
    parsed.protocol !==
    'https:'
  ) {
    return null;
  }

  const response =
    await fetch(
      url
    );

  if (
    !response.ok
  ) {
    return null;
  }

  const input =
    Buffer.from(
      await response
        .arrayBuffer()
    );

  if (
    input.length >
    20 *
    1024 *
    1024
  ) {
    return null;
  }

  const jpeg =
    await sharp(
      input
    )
      .rotate()
      .removeAlpha()
      .toColourspace(
        'srgb'
      )
      .resize({
        width:
          900,

        height:
          900,

        fit:
          'inside',

        withoutEnlargement:
          true
      })
      .jpeg({
        quality:
          80,

        chromaSubsampling:
          '4:2:0'
      })
      .toBuffer();

  return (
    `data:image/jpeg;base64,${jpeg.toString('base64')}`
  );
}

async function hydrateListingForSection(
  listing
) {
  const listingId =
    asListingId(
      listing
        ?.listing_id ||
      listing
    );

  let fullListing =
    listing;

  try {
    fullListing =
      await etsyRequest(
        `/listings/${listingId}`
      );

  } catch {
    fullListing =
      listing;
  }

  let images =
    [];

  try {
    const imageData =
      await getListingImages(
        listingId
      );

    const rawImages =
      Array.isArray(
        imageData
          ?.results
      )
        ? imageData.results
        : [];

    const ordered =
      [
        ...rawImages
      ]
        .filter(
          (
            image
          ) =>
            getImageUrl(
              image
            )
        )
        .sort(
          (
            a,
            b
          ) =>
            Number(
              a.rank ??
              9999
            ) -
            Number(
              b.rank ??
              9999
            )
        )
        .slice(
          0,
          SECTION_IMAGE_COUNT
        );

    images =
      (
        await Promise.all(
          ordered.map(
            async (
              image
            ) => {
              const url =
                getImageUrl(
                  image
                );

              try {
                const dataUrl =
                  await imageToDataUrl(
                    url
                  );

                return dataUrl
                  ? {
                      rank:
                        Number(
                          image
                            .rank ??
                          0
                        ),

                      data_url:
                        dataUrl
                    }
                  : null;

              } catch {
                return null;
              }
            }
          )
        )
      ).filter(
        Boolean
      );

  } catch {
    images =
      [];
  }

  return {
    listing_id:
      listingId,

    title:
      normalizeTitle(
        fullListing
          ?.title ||
        listing
          ?.title ||
        ''
      ),

    tags:
      normalizeTags(
        fullListing
          ?.tags ||
        listing
          ?.tags ||
        []
      ),

    description:
      normalizeDescription(
        fullListing
          ?.description ||
        listing
          ?.description ||
        ''
      ).slice(
        0,
        1200
      ),

    current_section_id:
      getListingSectionId(
        fullListing
      ) ||
      getListingSectionId(
        listing
      ),

    images
  };
}


/* =========================================================
   SECTION CLASSIFIER PROMPT
========================================================= */

function buildSectionClassifierInstructions(
  sections
) {
  const sectionText =
    sections
      .map(
        (
          section
        ) =>
          `${section.shop_section_id} = ${section.title}`
      )
      .join(
        '\n'
      );

  return `
You organize Etsy listings into EXISTING shop sections.

You MUST choose only from the section IDs below.
Never create a new section.
If none is a confident fit, return section_id null.

IMPORTANT:
Use BOTH listing text and supplied listing images.

The images are evidence of the REAL artwork/product.

Do not blindly trust the title if the artwork visibly shows something different.

Do not classify based on room furniture, books, plants, walls, frames or mockup styling.

Inspect the actual artwork/product shown inside the mockup.

If the text and visuals materially conflict, return section_id null and lower confidence.

CLASSIFICATION RULES

1. WILDLIFE & COUNTRY

If a REAL animal, bird, wildlife subject, horse, lion, wolf, owl, swan, eagle, tiger, fox, deer, reindeer, kangaroo or similar animal is a major subject of the actual artwork, prefer Wildlife & Country.

A city or landmark in the background does NOT override a major animal subject.

Examples:
Lion + Prague = Wildlife & Country
Horse + Lisbon = Wildlife & Country
Owl + Acropolis = Wildlife & Country
Swan + Amsterdam = Wildlife & Country
Wolf + Prague = Wildlife & Country
Tiger + India Gate = Wildlife & Country
Fox + London = Wildlife & Country
Kangaroo + Canberra = Wildlife & Country

But do NOT force Wildlife only because an animal word exists in the title.
The artwork itself should support the animal subject.

Rural, farm and country scenes may also fit Wildlife & Country.

2. FLORAL & COTTAGECORE

Use Floral & Cottagecore when flowers, roses, tulips, gardens, botanical arrangements or cottage garden imagery are the main artwork subject.

Do not classify as Floral because a small vase or plant appears in the room mockup.

3. EUROPE & MED TRAVEL

Use Europe & Med Travel when the artwork is mainly about a city, landmark, architecture, coast or travel destination AND there is no major animal subject.

If this is the shop's only travel section, it may also contain strong non-European travel landmarks when no better existing section exists.

Do not choose Travel only because a city name appears in the title.

4. DARK GOTHIC MOODY

Use Dark Gothic Moody when the actual artwork is primarily gothic, dark, eerie, nocturnal or moody and there is no stronger wildlife rule.

Do not use it merely because the mockup room is dark.

5. LUXURY PALACE FANTASY

Use Luxury Palace Fantasy for palace, royal, luxury, fantasy, mythical or opulent artwork when there is no stronger wildlife rule.

6. ABSTRACT MODERN RUSTIC

Use Abstract Modern Rustic for primarily abstract, modern, minimalist, rustic or stylized landscape artwork when none of the stronger rules apply.

GENERAL RULES

- Classify the PRODUCT/ARTWORK, not its room presentation.
- Different listings can have completely different artwork styles.
- Evaluate every listing independently.
- If image 1 is only a mockup and image 2 reveals the artwork more clearly, use the clearer evidence.
- If images disagree about the real product, return null unless the listing text resolves the conflict with high confidence.
- Ignore generic words such as canvas, wall art, print, decor, gift and home decor.
- Never create a new section.
- Confidence must reflect both visual and textual evidence.

EXISTING SECTIONS:
${sectionText}
`.trim();
}


/* =========================================================
   SECTION AI CLASSIFIER
========================================================= */

async function classifySectionChunk(
  sections,
  listings
) {
  const allowedIds =
    new Set(
      sections.map(
        (
          section
        ) =>
          String(
            section
              .shop_section_id
          )
      )
    );

  const schema = {
    type:
      'object',

    additionalProperties:
      false,

    required: [
      'assignments'
    ],

    properties: {
      assignments: {
        type:
          'array',

        items: {
          type:
            'object',

          additionalProperties:
            false,

          required: [
            'listing_id',
            'section_id',
            'confidence',
            'primary_visual_theme',
            'animal_major_subject',
            'visual_text_conflict',
            'reason'
          ],

          properties: {
            listing_id: {
              type:
                'string'
            },

            section_id: {
              type: [
                'integer',
                'null'
              ]
            },

            confidence: {
              type:
                'number',

              minimum:
                0,

              maximum:
                1
            },

            primary_visual_theme: {
              type:
                'string'
            },

            animal_major_subject: {
              type:
                'boolean'
            },

            visual_text_conflict: {
              type:
                'boolean'
            },

            reason: {
              type:
                'string'
            }
          }
        }
      }
    }
  };

  const content = [
    {
      type:
        'input_text',

      text:
        buildSectionClassifierInstructions(
          sections
        )
    }
  ];

  for (
    const listing of
    listings
  ) {
    content.push({
      type:
        'input_text',

      text:
`LISTING ${listing.listing_id}
TITLE: ${listing.title}
TAGS: ${JSON.stringify(listing.tags)}
DESCRIPTION: ${listing.description || '(empty)'}
IMAGES FOLLOW: ${listing.images.length}`
    });

    for (
      const image of
      listing.images
    ) {
      content.push({
        type:
          'input_text',

        text:
          `Listing ${listing.listing_id} image rank ${image.rank}`
      });

      content.push({
        type:
          'input_image',

        image_url:
          image.data_url,

        detail:
          'high'
      });
    }
  }

  content.push({
    type:
      'input_text',

    text:
      'Return exactly one assignment for every listing above.'
  });

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

            content
          }
        ],

        text: {
          format: {
            type:
              'json_schema',

            name:
              'etsy_section_assignments',

            strict:
              true,

            schema
          }
        }
      });

  const parsed =
    JSON.parse(
      response.output_text ||
      '{}'
    );

  const assignments =
    Array.isArray(
      parsed
        .assignments
    )
      ? parsed.assignments
      : [];

  const byListing =
    new Map(
      assignments.map(
        (
          item
        ) => [
          String(
            item
              .listing_id
          ),
          item
        ]
      )
    );

  return listings.map(
    (
      listing
    ) => {
      const listingId =
        String(
          listing
            .listing_id
        );

      const raw =
        byListing.get(
          listingId
        );

      const sectionId =
        raw
          ?.section_id ==
        null
          ? null
          : Number(
              raw
                .section_id
            );

      const validSection =
        sectionId !=
          null &&
        allowedIds.has(
          String(
            sectionId
          )
        );

      const confidence =
        Number(
          raw
            ?.confidence ||
          0
        );

      const visualTextConflict =
        raw
          ?.visual_text_conflict ===
        true;

      const ready =
        validSection &&
        confidence >=
          SECTION_CONFIDENCE_THRESHOLD &&
        !visualTextConflict;

      return {
        listing_id:
          listingId,

        title:
          listing.title,

        current_section_id:
          listing
            .current_section_id,

        proposed_section_id:
          ready
            ? sectionId
            : null,

        confidence,

        status:
          ready
            ? 'ready'
            : 'needs_review',

        primary_visual_theme:
          String(
            raw
              ?.primary_visual_theme ||
            ''
          ),

        animal_major_subject:
          raw
            ?.animal_major_subject ===
          true,

        visual_text_conflict:
          visualTextConflict,

        image_evidence_count:
          listing
            .images
            .length,

        reason:
          String(
            raw
              ?.reason ||
            'No confident section match'
          )
      };
    }
  );
}

async function classifyUngroupedListings(
  sections,
  listings
) {
  const hydrated =
    await mapWithConcurrency(
      listings,
      SECTION_HYDRATE_CONCURRENCY,
      hydrateListingForSection
    );

  const results =
    [];

  for (
    let i = 0;
    i <
    hydrated.length;
    i +=
      SECTION_CLASSIFY_BATCH
  ) {
    const chunk =
      hydrated.slice(
        i,
        i +
          SECTION_CLASSIFY_BATCH
      );

    const classified =
      await classifySectionChunk(
        sections,
        chunk
      );

    results.push(
      ...classified
    );
  }

  return results;
}


/* =========================================================
   SECTION PREVIEW
========================================================= */

async function saveSectionPreview(
  payload
) {
  const token =
    randomBytes(
      24
    ).toString(
      'base64url'
    );

  const value = {
    ...payload,

    token,

    created_at:
      Date.now()
  };

  await setJson(
    sectionPreviewKey(
      token
    ),
    value,
    {
      ex:
        PREVIEW_TTL_SECONDS
    }
  );

  return value;
}


/* =========================================================
   SECTION ASSIGNMENT
========================================================= */

async function assignListingToSection(
  listingId,
  sectionId
) {
  const shopId =
    await getShopId();

  const path =
    `/shops/${shopId}/listings/${listingId}`;

  const attempts = [
    {
      method:
        'PATCH',

      body: {
        shop_section_id:
          Number(
            sectionId
          )
      }
    },

    {
      method:
        'PATCH',

      body: {
        section_id:
          Number(
            sectionId
          )
      }
    },

    {
      method:
        'PUT',

      body: {
        section_id:
          Number(
            sectionId
          )
      }
    }
  ];

  let lastError =
    null;

  for (
    const attempt of
    attempts
  ) {
    try {
      await etsyRequest(
        path,
        attempt
      );

      const verified =
        await etsyRequest(
          `/listings/${listingId}`
        );

      if (
        getListingSectionId(
          verified
        ) ===
        Number(
          sectionId
        )
      ) {
        return {
          verified:
            true,

          listing:
            verified
        };
      }

    } catch (
      error
    ) {
      lastError =
        error;
    }
  }

  if (
    lastError
  ) {
    throw lastError;
  }

  const err =
    new Error(
      'Section assignment could not be verified'
    );

  err.status =
    409;

  throw err;
}


/* =========================================================
   ROUTER AUTH
========================================================= */

router.use(
  bridgeAuth
);


/* =========================================================
   HEALTH
========================================================= */

router.get(
  '/health',
  (
    _req,
    res
  ) => {
    res.json({
      ok:
        true,

      service:
        'vaelons-seo-engine',

      version:
        '3.0.0',

      model:
        SEO_MODEL,

      approval_required:
        'ONAYLIYORUM',

      safe_flow:
        'prepare -> QA -> preview -> approval -> PATCH -> verify',

      listing_directory:
        true,

      section_organizer:
        true,

      visual_section_classification:
        true,

      section_rule:
        'classify artwork/product, not room mockup'
    });
  }
);


/* =========================================================
   LIST LISTINGS
========================================================= */

router.get(
  '/listings',
  async (
    req,
    res,
    next
  ) => {
    try {
      const limit =
        clampInt(
          req.query
            .limit ||
          50,
          1,
          100
        );

      const offset =
        Math.max(
          0,
          Number(
            req.query
              .offset ||
            0
          )
        );

      const state =
        String(
          req.query
            .state ||
          'active'
        );

      const shopId =
        await getShopId();

      const [
        data,
        sections
      ] =
        await Promise.all([
          etsyRequest(
            `/shops/${shopId}/listings`,
            {
              params: {
                state,
                limit,
                offset
              }
            }
          ),

          getShopSections()
        ]);

      const sectionMap =
        new Map(
          sections.map(
            (
              section
            ) => [
              section
                .shop_section_id,

              section
                .title
            ]
          )
        );

      const results =
        Array.isArray(
          data
            ?.results
        )
          ? data.results
          : [];

      res.json({
        count:
          Number(
            data
              ?.count ??
            results.length
          ),

        limit,

        offset,

        results:
          results.map(
            (
              listing
            ) => {
              const sectionId =
                getListingSectionId(
                  listing
                );

              return {
                listing_id:
                  Number(
                    listing
                      .listing_id
                  ),

                title:
                  normalizeTitle(
                    listing
                      .title ||
                    ''
                  ),

                state:
                  listing
                    .state ||
                  null,

                shop_section_id:
                  sectionId,

                section_title:
                  sectionId
                    ? sectionMap.get(
                        sectionId
                      ) ||
                      null
                    : null,

                grouped:
                  Boolean(
                    sectionId
                  )
              };
            }
          ),

        etsy_modified:
          false
      });

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);


/* =========================================================
   LIST SECTIONS
========================================================= */

router.get(
  '/sections',
  async (
    _req,
    res,
    next
  ) => {
    try {
      const sections =
        await getShopSections();

      res.json({
        count:
          sections.length,

        sections,

        etsy_modified:
          false
      });

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);


/* =========================================================
   SCAN UNGROUPED
========================================================= */

router.post(
  '/sections/scan',
  async (
    _req,
    res,
    next
  ) => {
    try {
      const [
        sections,
        listings
      ] =
        await Promise.all([
          getShopSections(),
          fetchAllActiveListings()
        ]);

      if (
        !sections.length
      ) {
        return res
          .status(
            409
          )
          .json({
            error:
              'No existing Etsy shop sections found. Organizer will not create new sections.',

            etsy_modified:
              false
          });
      }

      const validSectionIds =
        new Set(
          sections.map(
            (
              section
            ) =>
              section
                .shop_section_id
          )
        );

      const alreadyGrouped =
        [];

      const ungrouped =
        [];

      for (
        const listing of
        listings
      ) {
        const sectionId =
          getListingSectionId(
            listing
          );

        if (
          sectionId &&
          validSectionIds.has(
            sectionId
          )
        ) {
          alreadyGrouped.push(
            listing
          );

        } else {
          ungrouped.push(
            listing
          );
        }
      }

      const assignments =
        ungrouped.length
          ? await classifyUngroupedListings(
              sections,
              ungrouped
            )
          : [];

      const sectionMap =
        new Map(
          sections.map(
            (
              section
            ) => [
              section
                .shop_section_id,

              section
                .title
            ]
          )
        );

      const enriched =
        assignments.map(
          (
            item
          ) => ({
            ...item,

            proposed_section_title:
              item
                .proposed_section_id
                ? sectionMap.get(
                    item
                      .proposed_section_id
                  ) ||
                  null
                : null
          })
        );

      const preview =
        await saveSectionPreview({
          active_listing_count:
            listings.length,

          already_grouped_count:
            alreadyGrouped.length,

          ungrouped_count:
            ungrouped.length,

          ready_count:
            enriched.filter(
              (
                item
              ) =>
                item
                  .status ===
                'ready'
            ).length,

          needs_review_count:
            enriched.filter(
              (
                item
              ) =>
                item
                  .status ===
                'needs_review'
            ).length,

          sections,

          assignments:
            enriched
        });

      res.json({
        action:
          'section_preview_ready',

        active_listing_count:
          listings.length,

        already_grouped_count:
          alreadyGrouped.length,

        ungrouped_count:
          ungrouped.length,

        ready_count:
          preview
            .ready_count,

        needs_review_count:
          preview
            .needs_review_count,

        assignments:
          enriched,

        preview_token:
          preview
            .token,

        approval_required:
          'ONAYLIYORUM',

        etsy_modified:
          false
      });

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);


/* =========================================================
   APPLY SECTIONS
========================================================= */

router.post(
  '/sections/apply',
  async (
    req,
    res,
    next
  ) => {
    let etsyModified =
      false;

    try {
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
          .status(
            400
          )
          .json({
            error:
              'Exact approval text ONAYLIYORUM is required',

            etsy_modified:
              false
          });
      }

      const preview =
        await getJson(
          sectionPreviewKey(
            token
          )
        );

      if (
        !preview
      ) {
        return res
          .status(
            404
          )
          .json({
            error:
              'Section preview not found or expired',

            etsy_modified:
              false
          });
      }

      const currentSections =
        await getShopSections();

      const currentSectionIds =
        new Set(
          currentSections.map(
            (
              section
            ) =>
              section
                .shop_section_id
          )
        );

      const ready =
        Array.isArray(
          preview
            .assignments
        )
          ? preview
              .assignments
              .filter(
                (
                  item
                ) =>
                  item
                    .status ===
                    'ready' &&
                  Number(
                    item
                      .confidence ||
                    0
                  ) >=
                    SECTION_CONFIDENCE_THRESHOLD &&
                  item
                    .visual_text_conflict !==
                    true &&
                  currentSectionIds.has(
                    Number(
                      item
                        .proposed_section_id
                    )
                  )
              )
          : [];

      const placed =
        [];

      const skipped =
        [];

      const failed =
        [];

      for (
        const item of
        ready
      ) {
        const listingId =
          asListingId(
            item
              .listing_id
          );

        try {
          const current =
            await etsyRequest(
              `/listings/${listingId}`
            );

          const currentSectionId =
            getListingSectionId(
              current
            );

          if (
            currentSectionId
          ) {
            skipped.push({
              listing_id:
                Number(
                  listingId
                ),

              title:
                normalizeTitle(
                  current
                    .title ||
                  item
                    .title ||
                  ''
                ),

              reason:
                'listing_is_already_grouped',

              current_section_id:
                currentSectionId
            });

            continue;
          }

          const result =
            await assignListingToSection(
              listingId,
              Number(
                item
                  .proposed_section_id
              )
            );

          etsyModified =
            true;

          placed.push({
            listing_id:
              Number(
                listingId
              ),

            title:
              normalizeTitle(
                result
                  .listing
                  ?.title ||
                item
                  .title ||
                ''
              ),

            section_id:
              Number(
                item
                  .proposed_section_id
              ),

            section_title:
              item
                .proposed_section_title ||
              null,

            verified:
              true
          });

        } catch (
          error
        ) {
          failed.push({
            listing_id:
              Number(
                listingId
              ),

            title:
              item
                .title ||
              null,

            error:
              error
                .message
          });
        }
      }

      res
        .status(
          failed.length
            ? 207
            : 200
        )
        .json({
          success:
            failed.length ===
            0,

          action:
            'section_organization_applied',

          placed_count:
            placed.length,

          skipped_count:
            skipped.length,

          failed_count:
            failed.length,

          needs_review_count:
            Array.isArray(
              preview
                .assignments
            )
              ? preview
                  .assignments
                  .filter(
                    (
                      item
                    ) =>
                      item
                        .status ===
                      'needs_review'
                  )
                  .length
              : 0,

          placed,

          skipped,

          failed,

          etsy_modified:
            etsyModified
        });

    } catch (
      error
    ) {
      error.etsyModified =
        etsyModified;

      next(
        error
      );
    }
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
        !validation
          .valid
      ) {
        await setJson(
          stateKey(
            listingId
          ),
          {
            status:
              'blocked_validation',

            checked_at:
              Date.now(),

            validation_errors:
              validation
                .errors
          }
        );

        return res
          .status(
            422
          )
          .json({
            listing_id:
              Number(
                listingId
              ),

            exact_title:
              original
                .title,

            action:
              'blocked',

            reason:
              'seo_proposal_failed_validation',

            validation_errors:
              validation
                .errors,

            etsy_modified:
              false
          });
      }

      const normalized =
        validation
          .normalized;

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

      if (
        noChanges
      ) {
        await setJson(
          stateKey(
            listingId
          ),
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
            Number(
              listingId
            ),

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

      if (
        !qa
          .passed
      ) {
        await setJson(
          stateKey(
            listingId
          ),
          {
            status:
              'blocked_qa',

            checked_at:
              Date.now(),

            qa
          }
        );

        return res
          .status(
            422
          )
          .json({
            listing_id:
              Number(
                listingId
              ),

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
            String(
              listingId
            ),

          original,

          original_hash:
            snapshotHash(
              original
            ),

          proposed:
            normalized,

          proposal: {
            change_title:
              proposal
                .change_title ===
              true,

            change_tags:
              proposal
                .change_tags ===
              true,

            change_description:
              proposal
                .change_description ===
              true,

            confidence:
              Number(
                proposal
                  .confidence ||
                0
              ),

            risk_level:
              String(
                proposal
                  .risk_level ||
                'medium'
              ),

            reason:
              String(
                proposal
                  .reason ||
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
          Number(
            listingId
          ),

        exact_title:
          original.title,

        action:
          'preview_ready',

        original,

        proposed:
          normalized,

        change_flags:
          preview
            .proposal,

        qa,

        preview_token:
          preview
            .token,

        approval_required:
          'ONAYLIYORUM',

        etsy_modified:
          false
      });

    } catch (
      error
    ) {
      next(
        error
      );
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
          Number(
            listingId
          ),

        state:
          await getJson(
            stateKey(
              listingId
            )
          ),

        recent_history:
          await latestHistory(
            listingId
          ),

        etsy_modified:
          false
      });

    } catch (
      error
    ) {
      next(
        error
      );
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
          .status(
            400
          )
          .json({
            error:
              'Exact approval text ONAYLIYORUM is required',

            etsy_modified:
              false
          });
      }

      const preview =
        await getJson(
          previewKey(
            token
          )
        );

      if (
        !preview
      ) {
        return res
          .status(
            404
          )
          .json({
            error:
              'SEO preview not found or expired',

            etsy_modified:
              false
          });
      }

      if (
        String(
          preview
            .listing_id
        ) !==
        listingId
      ) {
        return res
          .status(
            409
          )
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
          .status(
            409
          )
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
        snapshotHash(
          current
        ) !==
        preview
          .original_hash
      ) {
        return res
          .status(
            409
          )
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
        !Object.keys(
          body
        ).length
      ) {
        return res
          .status(
            409
          )
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
          preview
            .proposed,
          verified,
          preview
            .proposal
        );

      await addHistory(
        listingId,
        {
          type:
            'seo_publish',

          success:
            publishedOk,

          preview_token:
            token,

          before:
            preview
              .original,

          after_expected:
            preview
              .proposed,

          after_verified:
            verified,

          change_flags:
            preview
              .proposal,

          qa:
            preview
              .qa
        }
      );

      await setJson(
        stateKey(
          listingId
        ),
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
            Object.keys(
              body
            ),

          before:
            preview
              .original,

          after:
            verified,

          verified:
            publishedOk,

          etsy_modified:
            true
        });

    } catch (
      error
    ) {
      error.etsyModified =
        etsyModified;

      next(
        error
      );
    }
  }
);


/* =========================================================
   ROLLBACK SEO
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
          .status(
            400
          )
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
          (
            item
          ) =>
            item
              ?.type ===
              'seo_publish' &&
            item
              ?.success ===
              true
        );

      if (
        !lastPublish
      ) {
        return res
          .status(
            404
          )
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
        snapshotHash(
          current
        ) !==
        snapshotHash(
          lastPublish
            .after_verified
        )
      ) {
        return res
          .status(
            409
          )
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
        verified
          .title ===
          lastPublish
            .before
            .title &&
        sameArray(
          verified
            .tags,
          lastPublish
            .before
            .tags
        ) &&
        verified
          .description ===
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
            lastPublish
              .before,

          verified
        }
      );

      await setJson(
        stateKey(
          listingId
        ),
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

    } catch (
      error
    ) {
      error.etsyModified =
        etsyModified;

      next(
        error
      );
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
