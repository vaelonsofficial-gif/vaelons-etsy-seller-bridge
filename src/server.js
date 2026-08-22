import express from 'express';
import sharp from 'sharp';
import OpenAI, { toFile } from 'openai';
import { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';

import {
  randomBase64Url,
  pkceChallenge,
  sealJson,
  openJson
} from './crypto.js';

import {
  etsyRequest,
  getShopId,
  etsyApiKeyForOAuth,
  setInitialToken,
  getTokenStatus,
  getListingImages,
  uploadListingImage
} from './etsy.js';

const app = express();

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  express.urlencoded({
    extended: false
  })
);

let openaiClient = null;
let redisClient = null;


/* =========================================================
   CONFIG
========================================================= */

const PREFIX =
  'vaelons:thumbnail-worker:v2';

const PREVIEW_TTL_SECONDS =
  24 * 60 * 60;

const QA_RETRY_COOLDOWN_MS =
  24 * 60 * 60 * 1000;

const LOCK_TTL_SECONDS =
  10 * 60;

const WORKER_MODE =
  String(
    process.env.WORKER_MODE ||
    'safe'
  ).toLowerCase();

const WORKER_BATCH_SIZE =
  clampInt(
    process.env.WORKER_BATCH_SIZE ||
    2,
    1,
    5
  );

const BAD_SCORE_THRESHOLD =
  clampInt(
    process.env.BAD_SCORE_THRESHOLD ||
    65,
    20,
    95
  );

const DARK_BRIGHTNESS_THRESHOLD =
  clampInt(
    process.env.DARK_BRIGHTNESS_THRESHOLD ||
    78,
    30,
    150
  );

const AUTO_DELETE_OLD_RANK1 =
  envBool(
    'AUTO_DELETE_OLD_RANK1',
    true
  );

const IMAGE_MODEL =
  process.env.OPENAI_IMAGE_MODEL ||
  'gpt-image-2';

const QA_MODEL =
  process.env.OPENAI_QA_MODEL ||
  'gpt-5.6-luna';

const IMAGE_SIZE =
  process.env.OPENAI_IMAGE_SIZE ||
  '1024x1024';

const IMAGE_QUALITY =
  process.env.OPENAI_IMAGE_QUALITY ||
  'medium';


/* =========================================================
   BASIC HELPERS
========================================================= */

function required(name) {
  const value =
    process.env[name];

  if (!value) {
    throw new Error(
      `Missing environment variable: ${name}`
    );
  }

  return value;
}

function publicBase() {
  return required(
    'PUBLIC_BASE_URL'
  ).replace(
    /\/$/,
    ''
  );
}

function envBool(
  name,
  fallback = false
) {
  const raw =
    process.env[name];

  if (
    raw == null ||
    raw === ''
  ) {
    return fallback;
  }

  return [
    '1',
    'true',
    'yes',
    'on'
  ].includes(
    String(
      raw
    ).toLowerCase()
  );
}

function clamp(
  value,
  min,
  max
) {
  return Math.max(
    min,
    Math.min(
      max,
      Number(
        value
      )
    )
  );
}

function clampInt(
  value,
  min,
  max
) {
  return Math.round(
    clamp(
      value,
      min,
      max
    )
  );
}

function round1(value) {
  return (
    Math.round(
      Number(
        value
      ) *
      10
    ) /
    10
  );
}

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

function getImageId(
  image
) {
  return (
    image
      ?.listing_image_id ??
    image
      ?.image_id ??
    null
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

function parseCookies(
  req
) {
  const result =
    {};

  for (
    const part of
    (
      req.headers.cookie ||
      ''
    ).split(';')
  ) {
    const idx =
      part.indexOf('=');

    if (
      idx >
      -1
    ) {
      result[
        part
          .slice(
            0,
            idx
          )
          .trim()
      ] =
        decodeURIComponent(
          part
            .slice(
              idx + 1
            )
            .trim()
        );
    }
  }

  return result;
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
          'unauthorized'
      });
  }

  next();
}

function workerAuth(
  req,
  res,
  next
) {
  const auth =
    req.get(
      'authorization'
    ) ||
    '';

  const cronSecret =
    process.env
      .CRON_SECRET ||
    '';

  const bridgeKey =
    process.env
      .BRIDGE_API_KEY ||
    '';

  const allowed =
    (
      cronSecret &&
      auth ===
        `Bearer ${cronSecret}`
    ) ||
    (
      bridgeKey &&
      auth ===
        `Bearer ${bridgeKey}`
    );

  if (
    !allowed
  ) {
    return res
      .status(
        401
      )
      .json({
        error:
          'unauthorized'
      });
  }

  next();
}


/* =========================================================
   CLIENTS
========================================================= */

function openai() {
  if (
    !openaiClient
  ) {
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
  if (
    !redisClient
  ) {
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

    if (
      !url ||
      !token
    ) {
      throw new Error(
        'Missing Upstash Redis environment variables. Expected UPSTASH_REDIS_REST_KV_REST_API_URL and UPSTASH_REDIS_REST_KV_REST_API_TOKEN.'
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
   REDIS KEYS
========================================================= */

function stateKey(
  listingId
) {
  return (
    `${PREFIX}:listing:${listingId}`
  );
}

function previewKey(
  token
) {
  return (
    `${PREFIX}:preview:${token}`
  );
}

function previewImageKey(
  token
) {
  return (
    `${PREFIX}:preview-image:${token}`
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
    raw == null
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


/* =========================================================
   IMAGE DOWNLOAD
========================================================= */

async function downloadImage(
  url
) {
  const parsed =
    new URL(
      url
    );

  if (
    parsed.protocol !==
    'https:'
  ) {
    throw new Error(
      'Image URL must use HTTPS'
    );
  }

  const response =
    await fetch(
      url
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Could not download image (${response.status})`
    );
  }

  const buffer =
    Buffer.from(
      await response
        .arrayBuffer()
    );

  if (
    buffer.length >
    20 *
    1024 *
    1024
  ) {
    const err =
      new Error(
        'Image is larger than 20 MB'
      );

    err.status =
      413;

    throw err;
  }

  return buffer;
}


/* =========================================================
   IMAGE NORMALIZATION
========================================================= */

async function normalizeJpeg(
  buffer,
  max = 1600,
  quality = 90
) {
  return sharp(
    buffer
  )
    .rotate()
    .removeAlpha()
    .toColourspace(
      'srgb'
    )
    .resize({
      width:
        max,

      height:
        max,

      fit:
        'inside',

      withoutEnlargement:
        true
    })
    .jpeg({
      quality,

      chromaSubsampling:
        '4:4:4'
    })
    .toBuffer();
}


/* =========================================================
   IMAGE ANALYSIS
========================================================= */

async function analyzeImage(
  buffer
) {
  const meta =
    await sharp(
      buffer
    ).metadata();

  const {
    data,
    info
  } =
    await sharp(
      buffer
    )
      .rotate()
      .removeAlpha()
      .greyscale()
      .resize({
        width:
          360,

        height:
          360,

        fit:
          'inside',

        withoutEnlargement:
          true
      })
      .raw()
      .toBuffer({
        resolveWithObject:
          true
      });

  let sum =
    0;

  let sumSq =
    0;

  let shadow =
    0;

  let deepShadow =
    0;

  let highlight =
    0;

  const count =
    Math.max(
      1,
      info.width *
      info.height
    );

  for (
    let i = 0;
    i <
    data.length;
    i +=
      info.channels
  ) {
    const y =
      data[i];

    sum +=
      y;

    sumSq +=
      y *
      y;

    if (
      y <
      55
    ) {
      shadow +=
        1;
    }

    if (
      y <
      28
    ) {
      deepShadow +=
        1;
    }

    if (
      y >
      235
    ) {
      highlight +=
        1;
    }
  }

  const mean =
    sum /
    count;

  const variance =
    Math.max(
      0,
      sumSq /
      count -
      mean *
      mean
    );

  return {
    width:
      meta.width ||
      null,

    height:
      meta.height ||
      null,

    brightness:
      round1(
        mean
      ),

    contrast:
      round1(
        Math.sqrt(
          variance
        )
      ),

    shadow_percent:
      round1(
        shadow /
        count *
        100
      ),

    deep_shadow_percent:
      round1(
        deepShadow /
        count *
        100
      ),

    highlight_percent:
      round1(
        highlight /
        count *
        100
      )
  };
}


/* =========================================================
   THUMBNAIL SCORE
========================================================= */

function thumbnailScore(
  a
) {
  let score =
    100;

  if (
    a.brightness <
    50
  ) {
    score -=
      40;

  } else if (
    a.brightness <
    65
  ) {
    score -=
      30;

  } else if (
    a.brightness <
    78
  ) {
    score -=
      18;

  } else if (
    a.brightness <
    90
  ) {
    score -=
      8;
  }

  if (
    a.shadow_percent >
    60
  ) {
    score -=
      25;

  } else if (
    a.shadow_percent >
    48
  ) {
    score -=
      15;

  } else if (
    a.shadow_percent >
    38
  ) {
    score -=
      8;
  }

  if (
    a.deep_shadow_percent >
    35
  ) {
    score -=
      12;

  } else if (
    a.deep_shadow_percent >
    25
  ) {
    score -=
      6;
  }

  if (
    a.contrast <
    25
  ) {
    score -=
      10;
  }

  if (
    a.highlight_percent >
    16
  ) {
    score -=
      8;
  }

  return clampInt(
    score,
    0,
    100
  );
}


/* =========================================================
   REFERENCE SCORE
========================================================= */

function heuristicReferenceScore(
  analysis,
  rank
) {
  const brightnessPenalty =
    Math.abs(
      analysis.brightness -
      120
    ) *
    0.35;

  const contrastBonus =
    clamp(
      analysis.contrast -
      25,
      0,
      30
    ) *
    0.7;

  const resolution =
    Math.max(
      1,
      (
        analysis.width ||
        1
      ) *
      (
        analysis.height ||
        1
      )
    );

  const resolutionBonus =
    clamp(
      Math.log10(
        resolution
      ) -
      5.5,
      0,
      1.5
    ) *
    8;

  const rankBonus =
    rank ===
    2
      ? 8
      : rank ===
        3
        ? 4
        : 0;

  return round1(
    70 -
    brightnessPenalty +
    contrastBonus +
    resolutionBonus +
    rankBonus
  );
}


/* =========================================================
   ETSY IMAGE SET
========================================================= */

async function getImageSet(
  listingId
) {
  const data =
    await getListingImages(
      listingId
    );

  const images =
    Array.isArray(
      data?.results
    )
      ? data.results
      : [];

  if (
    !images.length
  ) {
    const err =
      new Error(
        'No listing images found'
      );

    err.status =
      404;

    throw err;
  }

  const ordered =
    [
      ...images
    ].sort(
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
    );

  const rank1 =
    images.find(
      (
        img
      ) =>
        Number(
          img.rank
        ) ===
        1
    ) ||
    ordered[0];

  if (
    !rank1 ||
    !getImageUrl(
      rank1
    )
  ) {
    const err =
      new Error(
        'No usable rank 1 image'
      );

    err.status =
      404;

    throw err;
  }

  return {
    images:
      ordered,

    rank1
  };
}


/* =========================================================
   AI REFERENCE SELECTION
========================================================= */

async function selectReferencesWithVision(
  title,
  candidates
) {
  if (
    candidates.length ===
    1
  ) {
    return [
      candidates[0]
    ];
  }

  const content = [
    {
      type:
        'input_text',

      text:
        `You are selecting product-truth reference images for a new Etsy hero thumbnail.

Listing title:
${title || ''}

Choose the candidate that shows the actual product/artwork most clearly and faithfully.

Prefer straight, complete, uncropped, faithful product views.
Avoid dark, heavily perspectived, cropped, obstructed, or altered views.

A second candidate may be selected only if it adds useful product-truth detail.

Candidate images follow in order and are indexed from 0.`
    }
  ];

  for (
    let i = 0;
    i <
    candidates.length;
    i +=
      1
  ) {
    const candidate =
      candidates[i];

    const jpeg =
      await normalizeJpeg(
        candidate.buffer,
        1200,
        88
      );

    content.push({
      type:
        'input_text',

      text:
        `Candidate ${i}: Etsy rank ${candidate.rank}, image ID ${candidate.imageId}`
    });

    content.push({
      type:
        'input_image',

      image_url:
        `data:image/jpeg;base64,${jpeg.toString('base64')}`,

      detail:
        'high'
    });
  }

  const schema = {
    type:
      'object',

    additionalProperties:
      false,

    required: [
      'primary_index',
      'use_secondary',
      'secondary_index',
      'confidence',
      'reason'
    ],

    properties: {
      primary_index: {
        type:
          'integer'
      },

      use_secondary: {
        type:
          'boolean'
      },

      secondary_index: {
        type:
          'integer'
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

  try {
    const response =
      await openai()
        .responses
        .create({
          model:
            QA_MODEL,

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
                'reference_selector',

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

    const primaryIndex =
      Number(
        parsed.primary_index
      );

    const secondaryIndex =
      Number(
        parsed.secondary_index
      );

    if (
      Number.isInteger(
        primaryIndex
      ) &&
      primaryIndex >=
        0 &&
      primaryIndex <
        candidates.length
    ) {
      const selected = [
        candidates[
          primaryIndex
        ]
      ];

      if (
        parsed.use_secondary ===
          true &&
        Number.isInteger(
          secondaryIndex
        ) &&
        secondaryIndex >=
          0 &&
        secondaryIndex <
          candidates.length &&
        secondaryIndex !==
          primaryIndex
      ) {
        selected.push(
          candidates[
            secondaryIndex
          ]
        );
      }

      return selected.slice(
        0,
        2
      );
    }

  } catch (
    error
  ) {
    console.warn(
      'Reference selector fallback:',
      error.message
    );
  }

  return [
    ...candidates
  ]
    .sort(
      (
        a,
        b
      ) =>
        b.heuristicScore -
        a.heuristicScore
    )
    .slice(
      0,
      Math.min(
        2,
        candidates.length
      )
    );
}

async function selectReferences(
  title,
  imageSet
) {
  const sourceCandidates =
    imageSet.images
      .filter(
        (
          img
        ) =>
          Number(
            img.rank
          ) !==
            1 &&
          getImageUrl(
            img
          )
      )
      .slice(
        0,
        6
      );

  const fallback =
    sourceCandidates.length
      ? sourceCandidates
      : [
          imageSet.rank1
        ];

  const candidates =
    [];

  for (
    const image of
    fallback
  ) {
    try {
      const buffer =
        await downloadImage(
          getImageUrl(
            image
          )
        );

      const analysis =
        await analyzeImage(
          buffer
        );

      const rank =
        Number(
          image.rank ||
          99
        );

      candidates.push({
        image,

        imageId:
          getImageId(
            image
          ),

        rank,

        buffer,

        analysis,

        heuristicScore:
          heuristicReferenceScore(
            analysis,
            rank
          )
      });

    } catch (
      error
    ) {
      console.warn(
        'Reference candidate failed:',
        getImageId(
          image
        ),
        error.message
      );
    }
  }

  if (
    !candidates.length
  ) {
    throw new Error(
      'Could not obtain a usable reference image'
    );
  }

  return selectReferencesWithVision(
    title,
    candidates
  );
}


/* =========================================================
   GENERATION PROMPT
========================================================= */

function buildGenerationPrompt({
  title,
  reason
}) {
  return `
Create a premium Etsy first-image hero thumbnail for the exact product shown in the supplied reference image or images.

LISTING TITLE:
${title || 'Unknown'}

WHY A NEW THUMBNAIL IS NEEDED:
${reason}

PRODUCT TRUTH — NON-NEGOTIABLE:
- The supplied reference image or images are the product truth.
- Preserve the same actual artwork/product identity.
- Preserve the subject, important composition, important elements, orientation, and color identity of the actual product.
- Do not redesign, repaint, reinterpret, simplify, add, remove, or invent product/artwork content.
- Do not substitute a similar artwork or different product.
- Do not create text, badges, labels, logos, or watermarks.
- If the actual artwork contains a signature or text, preserve it only as part of the artwork; do not invent new text.

PRESENTATION:
- Create a NEW professional Etsy hero presentation around the exact product.
- The environment/mockup may be newly created, but the product itself must remain faithful to the reference.
- Make the product visually dominant and immediately understandable on a mobile screen.
- Use bright natural lighting, realistic shadows, clean tonal separation, and premium home-decor styling when appropriate.
- Avoid dark moody exposure, clutter, heavy HDR, extreme saturation, clipped highlights, and aggressive color grading.
- Use a square Etsy-ready composition with the product safely centered for thumbnail crops.
- Make it commercially attractive without changing what the customer is actually buying.

Return only the finished image.
`.trim();
}


/* =========================================================
   OPENAI IMAGE GENERATION
========================================================= */

async function generateThumbnail({
  title,
  references,
  reason,
  retryNote = ''
}) {
  const imageFiles =
    await Promise.all(
      references.map(
        async (
          ref,
          index
        ) => {
          const jpeg =
            await normalizeJpeg(
              ref.buffer,
              1600,
              95
            );

          return toFile(
            jpeg,
            `reference-${index + 1}.jpg`,
            {
              type:
                'image/jpeg'
            }
          );
        }
      )
    );

  const prompt =
    `${buildGenerationPrompt({
      title,
      reason
    })}${
      retryNote
        ? `

QUALITY-CHECK FEEDBACK FROM THE PREVIOUS ATTEMPT:
${retryNote}

Fix that problem while preserving the exact product identity.`
        : ''
    }`;

  const response =
    await openai()
      .images
      .edit({
        model:
          IMAGE_MODEL,

        image:
          imageFiles,

        prompt,

        size:
          IMAGE_SIZE,

        quality:
          IMAGE_QUALITY
      });

  const b64 =
    response
      ?.data
      ?.[0]
      ?.b64_json;

  if (
    !b64
  ) {
    throw new Error(
      'OpenAI image response did not contain image data'
    );
  }

  return normalizeJpeg(
    Buffer.from(
      b64,
      'base64'
    ),
    1800,
    92
  );
}


/* =========================================================
   AI QUALITY GATE
========================================================= */

async function qualityCheck({
  title,
  referenceBuffers,
  generatedBuffer
}) {
  const references =
    await Promise.all(
      referenceBuffers.map(
        (
          buffer
        ) =>
          normalizeJpeg(
            buffer,
            1200,
            90
          )
      )
    );

  const generated =
    await normalizeJpeg(
      generatedBuffer,
      1200,
      90
    );

  const generatedAnalysis =
    await analyzeImage(
      generated
    );

  const technicalPass =
    generatedAnalysis
      .brightness >=
      82 &&
    generatedAnalysis
      .shadow_percent <=
      50 &&
    generatedAnalysis
      .highlight_percent <=
      18 &&
    generatedAnalysis
      .contrast >=
      24;

  const schema = {
    type:
      'object',

    additionalProperties:
      false,

    required: [
      'pass',
      'same_product',
      'same_artwork_identity',
      'important_elements_preserved',
      'color_identity_preserved',
      'invented_product_content',
      'thumbnail_readable',
      'confidence',
      'reason'
    ],

    properties: {
      pass: {
        type:
          'boolean'
      },

      same_product: {
        type:
          'boolean'
      },

      same_artwork_identity: {
        type:
          'boolean'
      },

      important_elements_preserved: {
        type:
          'boolean'
      },

      color_identity_preserved: {
        type:
          'boolean'
      },

      invented_product_content: {
        type:
          'boolean'
      },

      thumbnail_readable: {
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

  const content = [
    {
      type:
        'input_text',

      text:
        `You are the final safety gate for an Etsy thumbnail replacement.

Listing title:
${title || ''}

Every image except the final image is a product-truth reference.
The final image is the generated candidate.

PASS only when:
- candidate clearly shows the same actual product/artwork
- important subject and composition remain faithful
- color identity remains faithful
- no product content was invented
- no different product was substituted
- candidate is readable as a mobile Etsy thumbnail

The presentation environment may differ.
Be strict.`
    },

    ...references.map(
      (
        reference
      ) => ({
        type:
          'input_image',

        image_url:
          `data:image/jpeg;base64,${reference.toString('base64')}`,

        detail:
          'high'
      })
    ),

    {
      type:
        'input_image',

      image_url:
        `data:image/jpeg;base64,${generated.toString('base64')}`,

      detail:
        'high'
    }
  ];

  let semantic;

  try {
    const response =
      await openai()
        .responses
        .create({
          model:
            QA_MODEL,

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
                'etsy_thumbnail_qc',

              strict:
                true,

              schema
            }
          }
        });

    semantic =
      JSON.parse(
        response.output_text ||
        '{}'
      );

  } catch (
    error
  ) {
    semantic = {
      pass:
        false,

      same_product:
        false,

      same_artwork_identity:
        false,

      important_elements_preserved:
        false,

      color_identity_preserved:
        false,

      invented_product_content:
        true,

      thumbnail_readable:
        false,

      confidence:
        0,

      reason:
        `Quality-control request failed: ${error.message}`
    };
  }

  const semanticPass =
    semantic.pass ===
      true &&
    semantic.same_product ===
      true &&
    semantic.same_artwork_identity ===
      true &&
    semantic.important_elements_preserved ===
      true &&
    semantic.color_identity_preserved ===
      true &&
    semantic.invented_product_content ===
      false &&
    semantic.thumbnail_readable ===
      true &&
    Number(
      semantic.confidence ||
      0
    ) >=
      0.75;

  return {
    passed:
      technicalPass &&
      semanticPass,

    technical_passed:
      technicalPass,

    semantic_passed:
      semanticPass,

    generated_analysis:
      generatedAnalysis,

    semantic
  };
}


/* =========================================================
   PREVIEW STORAGE
========================================================= */

async function savePreview({
  listingId,
  title,
  sourceImageId,
  referenceImageIds,
  generatedBuffer,
  qc,
  reason
}) {
  const token =
    randomBytes(
      24
    ).toString(
      'base64url'
    );

  const compact =
    await normalizeJpeg(
      generatedBuffer,
      1400,
      86
    );

  const meta = {
    token,

    listingId:
      String(
        listingId
      ),

    title:
      title ||
      null,

    sourceImageId:
      String(
        sourceImageId
      ),

    referenceImageIds:
      referenceImageIds.map(
        String
      ),

    qc,

    reason,

    createdAt:
      Date.now()
  };

  await Promise.all([
    setJson(
      previewKey(
        token
      ),
      meta,
      {
        ex:
          PREVIEW_TTL_SECONDS
      }
    ),

    redis().set(
      previewImageKey(
        token
      ),
      compact.toString(
        'base64'
      ),
      {
        ex:
          PREVIEW_TTL_SECONDS
      }
    )
  ]);

  return {
    ...meta,

    previewUrl:
      `${publicBase()}/preview/worker/${token}`
  };
}

async function loadPreview(
  token
) {
  const meta =
    await getJson(
      previewKey(
        token
      )
    );

  const base64 =
    await redis().get(
      previewImageKey(
        token
      )
    );

  if (
    !meta ||
    !base64
  ) {
    const err =
      new Error(
        'Preview not found or expired'
      );

    err.status =
      404;

    throw err;
  }

  return {
    ...meta,

    generatedBuffer:
      Buffer.from(
        String(
          base64
        ),
        'base64'
      )
  };
}


/* =========================================================
   SAFE OLD IMAGE DELETE
========================================================= */

async function deleteOldRank1IfSafe({
  listingId,
  oldImageId,
  replacementImageId
}) {
  const imageSet =
    await getImageSet(
      listingId
    );

  const currentRank1 =
    imageSet.images.find(
      (
        img
      ) =>
        Number(
          img.rank
        ) ===
        1
    ) ||
    imageSet.images[0];

  if (
    String(
      getImageId(
        currentRank1
      )
    ) !==
    String(
      replacementImageId
    )
  ) {
    return {
      deleted:
        false,

      reason:
        'replacement_is_not_rank1'
    };
  }

  const oldImage =
    imageSet.images.find(
      (
        img
      ) =>
        String(
          getImageId(
            img
          )
        ) ===
        String(
          oldImageId
        )
    );

  if (
    !oldImage
  ) {
    return {
      deleted:
        false,

      reason:
        'old_image_already_absent'
    };
  }

  let variationData;

  try {
    variationData =
      await etsyRequest(
        `/shops/${await getShopId()}/listings/${listingId}/variation-images`
      );

  } catch (
    error
  ) {
    return {
      deleted:
        false,

      reason:
        'variation_safety_check_failed',

      detail:
        error.message
    };
  }

  const usedByVariation =
    (
      variationData
        ?.results ||
      []
    ).some(
      (
        item
      ) =>
        String(
          item
            ?.image_id
        ) ===
        String(
          oldImageId
        )
    );

  if (
    usedByVariation
  ) {
    return {
      deleted:
        false,

      reason:
        'old_image_used_by_variation'
    };
  }

  try {
    await etsyRequest(
      `/shops/${await getShopId()}/listings/${listingId}/images/${oldImageId}`,
      {
        method:
          'DELETE'
      }
    );

  } catch (
    error
  ) {
    const probe =
      await getImageSet(
        listingId
      ).catch(
        () =>
          null
      );

    const stillThere =
      probe
        ?.images
        ?.some(
          (
            img
          ) =>
            String(
              getImageId(
                img
              )
            ) ===
            String(
              oldImageId
            )
        );

    if (
      !probe ||
      stillThere
    ) {
      throw error;
    }
  }

  const after =
    await getImageSet(
      listingId
    );

  const afterRank1 =
    after.images.find(
      (
        img
      ) =>
        Number(
          img.rank
        ) ===
        1
    ) ||
    after.images[0];

  return {
    deleted:
      true,

    replacement_still_rank1:
      String(
        getImageId(
          afterRank1
        )
      ) ===
      String(
        replacementImageId
      )
  };
}


/* =========================================================
   SAFE PUBLISH
========================================================= */

async function publishPreview(
  preview,
  {
    deleteOld = false
  } = {}
) {
  let uploadOccurred =
    false;

  try {
    const listingId =
      asListingId(
        preview
          .listingId
      );

    const imageSet =
      await getImageSet(
        listingId
      );

    const currentRank1 =
      imageSet.rank1;

    if (
      String(
        getImageId(
          currentRank1
        )
      ) !==
      String(
        preview
          .sourceImageId
      )
    ) {
      const err =
        new Error(
          'Rank 1 changed after preview was created. Generate a fresh preview.'
        );

      err.status =
        409;

      throw err;
    }

    if (
      imageSet
        .images
        .length >=
      20
    ) {
      const err =
        new Error(
          'Listing already has 20 images. Safe upload-before-delete is blocked.'
        );

      err.status =
        409;

      throw err;
    }

    if (
      preview
        ?.qc
        ?.passed !==
      true
    ) {
      const err =
        new Error(
          'Preview did not pass the quality gate'
        );

      err.status =
        409;

      throw err;
    }

    const beforeIds =
      new Set(
        imageSet
          .images
          .map(
            (
              img
            ) =>
              String(
                getImageId(
                  img
                )
              )
          )
          .filter(
            Boolean
          )
      );

    const uploadResult =
      await uploadListingImage({
        shopId:
          await getShopId(),

        listingId,

        imageBuffer:
          preview
            .generatedBuffer,

        filename:
          `vaelons-thumbnail-${listingId}.jpg`,

        contentType:
          'image/jpeg'
      });

    uploadOccurred =
      true;

    const uploadRecord =
      Array.isArray(
        uploadResult
          ?.results
      )
        ? uploadResult
            .results[0]
        : uploadResult;

    let uploadedImageId =
      getImageId(
        uploadRecord
      );

    let verifiedSet =
      null;

    for (
      let attempt = 0;
      attempt <
      5;
      attempt +=
      1
    ) {
      if (
        attempt >
        0
      ) {
        await new Promise(
          (
            resolve
          ) =>
            setTimeout(
              resolve,
              900
            )
        );
      }

      verifiedSet =
        await getImageSet(
          listingId
        );

      if (
        !uploadedImageId
      ) {
        const added =
          verifiedSet
            .images
            .filter(
              (
                img
              ) =>
                !beforeIds.has(
                  String(
                    getImageId(
                      img
                    )
                  )
                )
            );

        if (
          added.length ===
          1
        ) {
          uploadedImageId =
            getImageId(
              added[0]
            );
        }
      }

      const rank1 =
        verifiedSet
          .images
          .find(
            (
              img
            ) =>
              Number(
                img.rank
              ) ===
              1
          ) ||
        verifiedSet
          .images[0];

      if (
        uploadedImageId &&
        String(
          getImageId(
            rank1
          )
        ) ===
        String(
          uploadedImageId
        )
      ) {
        break;
      }
    }

    const finalRank1 =
      verifiedSet
        ?.images
        ?.find(
          (
            img
          ) =>
            Number(
              img.rank
            ) ===
            1
        ) ||
      verifiedSet
        ?.images
        ?.[0] ||
      null;

    const replacementIsRank1 =
      Boolean(
        uploadedImageId &&
        String(
          getImageId(
            finalRank1
          )
        ) ===
        String(
          uploadedImageId
        )
      );

    let cleanup = {
      deleted:
        false,

      reason:
        'not_requested'
    };

    if (
      replacementIsRank1 &&
      deleteOld
    ) {
      cleanup =
        await deleteOldRank1IfSafe({
          listingId,

          oldImageId:
            preview
              .sourceImageId,

          replacementImageId:
            uploadedImageId
        });
    }

    const result = {
      success:
        replacementIsRank1,

      listing_id:
        Number(
          listingId
        ),

      old_rank1_image_id:
        preview
          .sourceImageId,

      uploaded_image_id:
        uploadedImageId ||
        null,

      replacement_verified_as_rank1:
        replacementIsRank1,

      cleanup,

      etsy_modified:
        true
    };

    await setJson(
      stateKey(
        listingId
      ),
      {
        status:
          replacementIsRank1
            ? 'published'
            : 'manual_attention',

        sourceImageId:
          String(
            preview
              .sourceImageId
          ),

        uploadedImageId:
          uploadedImageId
            ? String(
                uploadedImageId
              )
            : null,

        previewToken:
          preview.token,

        publishedAt:
          Date.now(),

        qc:
          preview.qc,

        result
      }
    );

    return result;

  } catch (
    error
  ) {
    if (
      uploadOccurred
    ) {
      error.etsyModified =
        true;
    }

    throw error;
  }
}


/* =========================================================
   PREPARE ONE LISTING
========================================================= */

async function prepareListing(
  listing,
  {
    reason = 'manual',
    force = false
  } = {}
) {
  const listingId =
    asListingId(
      listing.listing_id ||
      listing.listingId ||
      listing
    );

  const exact =
    listing
      ?.title
      ? listing
      : await etsyRequest(
          `/listings/${listingId}`
        );

  const imageSet =
    await getImageSet(
      listingId
    );

  const sourceImageId =
    String(
      getImageId(
        imageSet.rank1
      )
    );

  const existing =
    await getJson(
      stateKey(
        listingId
      )
    );

  if (
    !force &&
    existing &&
    String(
      existing
        .sourceImageId ||
      ''
    ) ===
    sourceImageId
  ) {
    if (
      existing.status ===
      'preview_ready'
    ) {
      return {
        listing_id:
          Number(
            listingId
          ),

        exact_title:
          exact
            ?.title ||
          null,

        action:
          'skipped',

        reason:
          'preview_already_ready_for_current_rank1',

        state:
          existing,

        etsy_modified:
          false
      };
    }

    if (
      existing.status ===
      'manual_attention'
    ) {
      return {
        listing_id:
          Number(
            listingId
          ),

        exact_title:
          exact
            ?.title ||
          null,

        action:
          'blocked',

        reason:
          'manual_attention_required_before_retry',

        state:
          existing,

        etsy_modified:
          false
      };
    }

    if (
      existing.status ===
        'blocked_qa' &&
      Date.now() -
        Number(
          existing
            .checkedAt ||
          0
        ) <
        QA_RETRY_COOLDOWN_MS
    ) {
      return {
        listing_id:
          Number(
            listingId
          ),

        exact_title:
          exact
            ?.title ||
          null,

        action:
          'skipped',

        reason:
          'qa_retry_cooldown',

        state:
          existing,

        etsy_modified:
          false
      };
    }

    if (
      existing.status ===
        'published' &&
      String(
        existing
          .uploadedImageId ||
        ''
      ) ===
      sourceImageId
    ) {
      return {
        listing_id:
          Number(
            listingId
          ),

        exact_title:
          exact
            ?.title ||
          null,

        action:
          'keep',

        reason:
          'current_rank1_was_published_by_worker',

        state:
          existing,

        etsy_modified:
          false
      };
    }
  }

  const rank1Buffer =
    await downloadImage(
      getImageUrl(
        imageSet.rank1
      )
    );

  const rank1Analysis =
    await analyzeImage(
      rank1Buffer
    );

  const rank1Score =
    thumbnailScore(
      rank1Analysis
    );

  const isNew =
    reason ===
    'new_listing';

  const isBad =
    rank1Score <
      BAD_SCORE_THRESHOLD ||
    rank1Analysis
      .brightness <
      DARK_BRIGHTNESS_THRESHOLD;

  if (
    !force &&
    !isNew &&
    !isBad
  ) {
    const state = {
      status:
        'healthy',

      sourceImageId,

      checkedAt:
        Date.now(),

      rank1Score,

      rank1Analysis
    };

    await setJson(
      stateKey(
        listingId
      ),
      state
    );

    return {
      listing_id:
        Number(
          listingId
        ),

      exact_title:
        exact
          ?.title ||
        null,

      action:
        'keep',

      reason:
        'thumbnail_is_healthy',

      rank1_score:
        rank1Score,

      analysis:
        rank1Analysis,

      etsy_modified:
        false
    };
  }

  const references =
    await selectReferences(
      exact
        ?.title ||
      '',
      imageSet
    );

  const referenceImageIds =
    references.map(
      (
        ref
      ) =>
        getImageId(
          ref.image
        )
    );

  let generated =
    null;

  let qc =
    null;

  for (
    let attempt = 1;
    attempt <=
    2;
    attempt +=
      1
  ) {
    generated =
      await generateThumbnail({
        title:
          exact
            ?.title ||
          '',

        references,

        reason:
          isNew
            ? 'A new Etsy listing was detected and needs a fresh hero thumbnail.'
            : `The current Etsy thumbnail quality score is ${rank1Score}/100 and needs improvement.`,

        retryNote:
          attempt ===
          2
            ? qc
                ?.semantic
                ?.reason ||
              'Preserve the product identity more strictly and improve mobile readability.'
            : ''
      });

    qc =
      await qualityCheck({
        title:
          exact
            ?.title ||
          '',

        referenceBuffers:
          references.map(
            (
              ref
            ) =>
              ref.buffer
          ),

        generatedBuffer:
          generated
      });

    if (
      qc.passed
    ) {
      break;
    }
  }

  if (
    !qc
      ?.passed
  ) {
    const state = {
      status:
        'blocked_qa',

      sourceImageId,

      checkedAt:
        Date.now(),

      rank1Score,

      rank1Analysis,

      referenceImageIds:
        referenceImageIds.map(
          String
        ),

      qc
    };

    await setJson(
      stateKey(
        listingId
      ),
      state
    );

    return {
      listing_id:
        Number(
          listingId
        ),

      exact_title:
        exact
          ?.title ||
        null,

      action:
        'blocked',

      reason:
        'generated_thumbnail_failed_quality_gate',

      rank1_score:
        rank1Score,

      reference_image_ids:
        referenceImageIds,

      qc,

      etsy_modified:
        false
    };
  }

  const preview =
    await savePreview({
      listingId,

      title:
        exact
          ?.title ||
        null,

      sourceImageId,

      referenceImageIds,

      generatedBuffer:
        generated,

      qc,

      reason
    });

  await setJson(
    stateKey(
      listingId
    ),
    {
      status:
        'preview_ready',

      sourceImageId,

      previewToken:
        preview.token,

      previewUrl:
        preview.previewUrl,

      checkedAt:
        Date.now(),

      rank1Score,

      rank1Analysis,

      referenceImageIds:
        referenceImageIds.map(
          String
        ),

      qc
    }
  );

  if (
    WORKER_MODE ===
    'auto'
  ) {
    const publish =
      await publishPreview(
        {
          ...preview,

          generatedBuffer:
            generated
        },
        {
          deleteOld:
            AUTO_DELETE_OLD_RANK1
        }
      );

    return {
      listing_id:
        Number(
          listingId
        ),

      exact_title:
        exact
          ?.title ||
        null,

      action:
        'auto_published',

      reason,

      previous_rank1_score:
        rank1Score,

      reference_image_ids:
        referenceImageIds,

      qc,

      publish
    };
  }

  return {
    listing_id:
      Number(
        listingId
      ),

    exact_title:
      exact
        ?.title ||
      null,

    action:
      'preview_ready',

    reason,

    previous_rank1_score:
      rank1Score,

    source_image_id:
      sourceImageId,

    reference_image_ids:
      referenceImageIds,

    preview_token:
      preview.token,

    preview_url:
      preview.previewUrl,

    qc,

    approval_required:
      'ONAYLIYORUM',

    etsy_modified:
      false
  };
}


/* =========================================================
   FETCH ALL ACTIVE LISTINGS
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
   WORKER LOCK
========================================================= */

async function acquireWorkerLock() {
  const token =
    randomBytes(
      12
    ).toString(
      'hex'
    );

  const ok =
    await redis().set(
      `${PREFIX}:lock`,
      token,
      {
        nx:
          true,

        ex:
          LOCK_TTL_SECONDS
      }
    );

  return ok
    ? token
    : null;
}

async function releaseWorkerLock(
  token
) {
  const current =
    await redis().get(
      `${PREFIX}:lock`
    );

  if (
    String(
      current ||
      ''
    ) ===
    String(
      token
    )
  ) {
    await redis().del(
      `${PREFIX}:lock`
    );
  }
}


/* =========================================================
   MAIN WORKER
========================================================= */

async function runWorker() {
  const lockToken =
    await acquireWorkerLock();

  if (
    !lockToken
  ) {
    return {
      ok:
        false,

      skipped:
        true,

      reason:
        'worker_already_running'
    };
  }

  try {
    const listings =
      await fetchAllActiveListings();

    const initialized =
      Boolean(
        await redis().get(
          `${PREFIX}:initialized`
        )
      );

    if (
      !initialized
    ) {
      if (
        listings.length
      ) {
        await redis().sadd(
          `${PREFIX}:seen`,
          ...listings.map(
            (
              listing
            ) =>
              String(
                listing
                  .listing_id
              )
          )
        );
      }

      await redis().set(
        `${PREFIX}:initialized`,
        '1'
      );

    } else {
      for (
        const listing of
        listings
      ) {
        const id =
          String(
            listing
              .listing_id
          );

        const seen =
          Boolean(
            await redis().sismember(
              `${PREFIX}:seen`,
              id
            )
          );

        if (
          !seen
        ) {
          await redis().sadd(
            `${PREFIX}:seen`,
            id
          );

          await redis().sadd(
            `${PREFIX}:pending-new`,
            id
          );
        }
      }
    }

    const byId =
      new Map(
        listings.map(
          (
            listing
          ) => [
            String(
              listing
                .listing_id
            ),
            listing
          ]
        )
      );

    const pending =
      (
        await redis().smembers(
          `${PREFIX}:pending-new`
        )
      ).map(
        String
      );

    const selected =
      [];

    const selectedIds =
      new Set();

    for (
      const id of
      pending
    ) {
      if (
        selected.length >=
        WORKER_BATCH_SIZE
      ) {
        break;
      }

      const listing =
        byId.get(
          id
        );

      if (
        listing
      ) {
        selected.push({
          listing,

          reason:
            'new_listing'
        });

        selectedIds.add(
          id
        );

      } else {
        await redis().srem(
          `${PREFIX}:pending-new`,
          id
        );
      }
    }

    let cursor =
      Number(
        await redis().get(
          `${PREFIX}:scan-cursor`
        )
      ) ||
      0;

    if (
      listings.length
    ) {
      cursor %=
        listings.length;
    }

    let examined =
      0;

    while (
      selected.length <
        WORKER_BATCH_SIZE &&
      examined <
        listings.length
    ) {
      const index =
        (
          cursor +
          examined
        ) %
        listings.length;

      const listing =
        listings[
          index
        ];

      const id =
        String(
          listing
            .listing_id
        );

      if (
        !selectedIds.has(
          id
        )
      ) {
        selected.push({
          listing,

          reason:
            'rolling_scan'
        });

        selectedIds.add(
          id
        );
      }

      examined +=
        1;
    }

    if (
      listings.length
    ) {
      await redis().set(
        `${PREFIX}:scan-cursor`,
        String(
          (
            cursor +
            Math.max(
              1,
              examined
            )
          ) %
          listings.length
        )
      );
    }

    const results =
      [];

    for (
      const item of
      selected
    ) {
      try {
        const result =
          await prepareListing(
            item.listing,
            {
              reason:
                item.reason
            }
          );

        results.push(
          result
        );

        if (
          item.reason ===
            'new_listing' &&
          result.action !==
            'error'
        ) {
          await redis().srem(
            `${PREFIX}:pending-new`,
            String(
              item
                .listing
                .listing_id
            )
          );
        }

      } catch (
        error
      ) {
        results.push({
          listing_id:
            Number(
              item
                .listing
                .listing_id
            ),

          exact_title:
            item
              .listing
              .title ||
            null,

          action:
            'error',

          reason:
            item.reason,

          error:
            error.message,

          etsy_modified:
            error
              .etsyModified ===
            true
        });
      }
    }

    return {
      ok:
        true,

      mode:
        WORKER_MODE,

      bootstrap_run:
        !initialized,

      active_listing_count:
        listings.length,

      processed_count:
        results.length,

      pending_new_count:
        Number(
          await redis().scard(
            `${PREFIX}:pending-new`
          )
        ),

      results
    };

  } finally {
    await releaseWorkerLock(
      lockToken
    );
  }
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  (
    _req,
    res
  ) => {
    res.json({
      ok:
        true,

      service:
        'vaelons-ai-thumbnail-worker',

      version:
        '2.0.1',

      worker_mode:
        WORKER_MODE,

      image_model:
        IMAGE_MODEL,

      qa_model:
        QA_MODEL,

      openai_key_source:
        'VAELONS_OPENAI_API_KEY',

      safe_replace_order:
        'generate -> QA -> upload -> verify rank1 -> delete old'
    });
  }
);


/* =========================================================
   ETSY OAUTH
========================================================= */

app.get(
  '/oauth/etsy/start',
  (
    req,
    res
  ) => {
    try {
      if (
        req.query
          .setup_secret !==
        required(
          'SETUP_SECRET'
        )
      ) {
        return res
          .status(
            401
          )
          .send(
            'Invalid setup secret.'
          );
      }

      const state =
        randomBase64Url(
          24
        );

      const verifier =
        randomBase64Url(
          48
        );

      const challenge =
        pkceChallenge(
          verifier
        );

      const redirectUri =
        `${publicBase()}/oauth/etsy/callback`;

      const capsule =
        sealJson({
          state,
          verifier,
          ts:
            Date.now()
        });

      res.cookie(
        'etsy_oauth',
        capsule,
        {
          httpOnly:
            true,

          secure:
            true,

          sameSite:
            'lax',

          maxAge:
            10 *
            60 *
            1000
        }
      );

      const url =
        new URL(
          'https://www.etsy.com/oauth/connect'
        );

      url.searchParams.set(
        'response_type',
        'code'
      );

      url.searchParams.set(
        'client_id',
        etsyApiKeyForOAuth()
      );

      url.searchParams.set(
        'redirect_uri',
        redirectUri
      );

      url.searchParams.set(
        'scope',
        'listings_r listings_w shops_r shops_w'
      );

      url.searchParams.set(
        'state',
        state
      );

      url.searchParams.set(
        'code_challenge',
        challenge
      );

      url.searchParams.set(
        'code_challenge_method',
        'S256'
      );

      res.redirect(
        url.toString()
      );

    } catch (
      error
    ) {
      res
        .status(
          error.status ||
          500
        )
        .json({
          error:
            error.message
        });
    }
  }
);

app.get(
  '/oauth/etsy/callback',
  async (
    req,
    res
  ) => {
    try {
      if (
        req.query
          .error
      ) {
        return res
          .status(
            400
          )
          .send(
            `Etsy authorization failed: ${
              req.query
                .error_description ||
              req.query
                .error
            }`
          );
      }

      const cookie =
        parseCookies(
          req
        ).etsy_oauth;

      if (
        !cookie
      ) {
        return res
          .status(
            400
          )
          .send(
            'OAuth session expired. Start again.'
          );
      }

      const flow =
        openJson(
          cookie
        );

      if (
        !req.query
          .state ||
        req.query
          .state !==
          flow.state ||
        Date.now() -
          flow.ts >
          10 *
          60 *
          1000
      ) {
        return res
          .status(
            400
          )
          .send(
            'Invalid OAuth state.'
          );
      }

      const redirectUri =
        `${publicBase()}/oauth/etsy/callback`;

      const body =
        new URLSearchParams({
          grant_type:
            'authorization_code',

          client_id:
            etsyApiKeyForOAuth(),

          redirect_uri:
            redirectUri,

          code:
            String(
              req.query
                .code ||
              ''
            ),

          code_verifier:
            flow.verifier
        });

      const tokenRes =
        await fetch(
          'https://api.etsy.com/v3/public/oauth/token',
          {
            method:
              'POST',

            headers: {
              'content-type':
                'application/x-www-form-urlencoded; charset=utf-8'
            },

            body
          }
        );

      const token =
        await tokenRes.json();

      if (
        !tokenRes.ok
      ) {
        return res
          .status(
            400
          )
          .send(
            `Token exchange failed: ${JSON.stringify(token)}`
          );
      }

      await setInitialToken(
        token
      );

      const shopId =
        await getShopId();

      const encryptedCapsule =
        sealJson({
          refresh_token:
            token
              .refresh_token,

          shop_id:
            shopId
        });

      res.clearCookie(
        'etsy_oauth'
      );

      res
        .type(
          'html'
        )
        .send(`
<!doctype html>
<meta charset="utf-8">
<title>VAELONS Etsy Connected</title>

<h2>
VAELONS Etsy bağlantısı doğrulandı.
</h2>

<p>
Aşağıdaki şifreli değeri
<b>ETSY_TOKEN_CAPSULE</b>
olarak Vercel Environment Variables bölümüne ekleyin.
</p>

<textarea
  style="width:100%;height:150px"
  readonly
  onclick="this.select()"
>${encryptedCapsule}</textarea>
        `);

    } catch (
      error
    ) {
      res
        .status(
          error.status ||
          500
        )
        .json({
          error:
            error.message,

          details:
            error.details ||
            null
        });
    }
  }
);


/* =========================================================
   PUBLIC PREVIEW
========================================================= */

app.get(
  '/preview/worker/:token',
  async (
    req,
    res
  ) => {
    try {
      const token =
        String(
          req.params
            .token ||
          ''
        );

      const meta =
        await getJson(
          previewKey(
            token
          )
        );

      const base64 =
        await redis().get(
          previewImageKey(
            token
          )
        );

      if (
        !meta ||
        !base64
      ) {
        return res
          .status(
            404
          )
          .send(
            'Preview expired or not found.'
          );
      }

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.setHeader(
        'cache-control',
        'private, max-age=300'
      );

      res.send(
        Buffer.from(
          String(
            base64
          ),
          'base64'
        )
      );

    } catch (
      error
    ) {
      res
        .status(
          500
        )
        .send(
          error.message
        );
    }
  }
);


/* =========================================================
   WORKER API
========================================================= */

app.use(
  '/api/worker',
  workerAuth
);

app.get(
  '/api/worker/status',
  async (
    _req,
    res,
    next
  ) => {
    try {
      res.json({
        service:
          'vaelons-ai-thumbnail-worker',

        version:
          '2.0.1',

        mode:
          WORKER_MODE,

        etsy:
          await getTokenStatus(),

        initialized:
          Boolean(
            await redis().get(
              `${PREFIX}:initialized`
            )
          ),

        pending_new_count:
          Number(
            await redis().scard(
              `${PREFIX}:pending-new`
            )
          ),

        scan_cursor:
          Number(
            await redis().get(
              `${PREFIX}:scan-cursor`
            )
          ) ||
          0,

        auto_delete_old_rank1:
          AUTO_DELETE_OLD_RANK1,

        openai_key_source:
          'VAELONS_OPENAI_API_KEY',

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

const runHandler =
  async (
    _req,
    res,
    next
  ) => {
    try {
      res.json(
        await runWorker()
      );

    } catch (
      error
    ) {
      next(
        error
      );
    }
  };

app.get(
  '/api/worker/run',
  runHandler
);

app.post(
  '/api/worker/run',
  runHandler
);

app.post(
  '/api/worker/listings/:listingId/prepare',
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

      res.json(
        await prepareListing(
          listing,
          {
            reason:
              'manual',

            force:
              req.body
                ?.force ===
              true
          }
        )
      );

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.get(
  '/api/worker/listings/:listingId/status',
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

app.post(
  '/api/worker/listings/:listingId/publish',
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
        await loadPreview(
          token
        );

      if (
        String(
          preview
            .listingId
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

      res.json(
        await publishPreview(
          preview,
          {
            deleteOld:
              req.body
                ?.delete_old !==
              false
          }
        )
      );

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
   BASIC ETSY READ API
========================================================= */

app.use(
  '/api',
  bridgeAuth
);

app.get(
  '/api/token-status',
  async (
    _req,
    res,
    next
  ) => {
    try {
      res.json(
        await getTokenStatus()
      );

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.get(
  '/api/shop',
  async (
    _req,
    res,
    next
  ) => {
    try {
      res.json(
        await etsyRequest(
          `/shops/${await getShopId()}`
        )
      );

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.get(
  '/api/listings',
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
          25,
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

      res.json(
        await etsyRequest(
          `/shops/${await getShopId()}/listings`,
          {
            params: {
              limit,
              offset,
              state
            }
          }
        )
      );

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.get(
  '/api/listings/:listingId',
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

      res.json(
        await etsyRequest(
          `/listings/${listingId}`
        )
      );

    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.get(
  '/api/listings/:listingId/images',
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

      res.json(
        await getListingImages(
          listingId
        )
      );

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
   ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(
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


export default app;


if (
  !process.env
    .VERCEL
) {
  const port =
    Number(
      process.env.PORT ||
      3000
    );

  app.listen(
    port,
    () => {
      console.log(
        `VAELONS AI Thumbnail Worker listening on :${port}`
      );
    }
  );
}
