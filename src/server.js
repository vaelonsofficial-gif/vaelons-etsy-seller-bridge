import express from 'express';
import sharp from 'sharp';
import OpenAI, { toFile } from 'openai';
import { Redis } from '@upstash/redis';
import { randomBytes } from 'node:crypto';

import {
  etsyRequest,
  getShopId,
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

let openaiClient = null;
let redisClient = null;


/* =========================================================
   CLIENTS
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

function ai() {
  if (!openaiClient) {
    openaiClient =
      new OpenAI({
        apiKey:
          required(
            'OPENAI_API_KEY'
          )
      });
  }

  return openaiClient;
}

function db() {
  if (!redisClient) {
    redisClient =
      new Redis({
        url:
          required(
            'UPSTASH_REDIS_REST_URL'
          ),

        token:
          required(
            'UPSTASH_REDIS_REST_TOKEN'
          ),

        enableTelemetry:
          false
      });
  }

  return redisClient;
}


/* =========================================================
   CONFIG
========================================================= */

const PREFIX =
  'vaelons:thumb-worker:v1';

const PREVIEW_TTL_SECONDS =
  24 *
  60 *
  60;

const LOCK_TTL_SECONDS =
  9 *
  60;

const WORKER_MODE =
  String(
    process.env
      .WORKER_MODE ||
    'safe'
  ).toLowerCase();

const WORKER_BATCH_SIZE =
  clampInt(
    process.env
      .WORKER_BATCH_SIZE ||
    2,
    1,
    10
  );

const BAD_SCORE_THRESHOLD =
  clampInt(
    process.env
      .BAD_SCORE_THRESHOLD ||
    65,
    20,
    95
  );

const DARK_BRIGHTNESS_THRESHOLD =
  clampInt(
    process.env
      .DARK_BRIGHTNESS_THRESHOLD ||
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
  process.env
    .OPENAI_IMAGE_MODEL ||
  'gpt-image-2';

const QA_MODEL =
  process.env
    .OPENAI_QA_MODEL ||
  'gpt-5.6-luna';

const IMAGE_SIZE =
  process.env
    .OPENAI_IMAGE_SIZE ||
  '1536x1536';

const IMAGE_QUALITY =
  process.env
    .OPENAI_IMAGE_QUALITY ||
  'medium';


/* =========================================================
   BASIC HELPERS
========================================================= */

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
    null
  );
}

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


/* =========================================================
   REDIS HELPERS
========================================================= */

async function getJson(
  key
) {
  const raw =
    await db().get(
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
  return db().set(
    key,
    JSON.stringify(
      value
    ),
    options
  );
}


/* =========================================================
   AUTH
========================================================= */

function managerOrWorkerAuth(
  req,
  res,
  next
) {
  const auth =
    req.get(
      'authorization'
    ) ||
    '';

  const workerSecret =
    process.env
      .CRON_SECRET ||
    process.env
      .WORKER_SECRET ||
    '';

  const bridgeKey =
    process.env
      .BRIDGE_API_KEY ||
    '';

  const allowed =
    (
      workerSecret &&
      auth ===
      `Bearer ${workerSecret}`
    ) ||
    (
      bridgeKey &&
      auth ===
      `Bearer ${bridgeKey}`
    ) ||
    (
      workerSecret &&
      req.get(
        'x-worker-secret'
      ) ===
      workerSecret
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
    throw new Error(
      'Image is larger than 20 MB'
    );
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

  const stdev =
    Math.sqrt(
      variance
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
        stdev
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

function referenceScore(
  analysis,
  rank
) {
  const brightnessTarget =
    120;

  const brightnessPenalty =
    Math.abs(
      analysis.brightness -
      brightnessTarget
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
    throw new Error(
      'No listing images found'
    );
  }

  const ordered =
    [...images].sort(
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
      (img) =>
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
    throw new Error(
      'No usable rank 1 image'
    );
  }

  return {
    images:
      ordered,

    rank1
  };
}


/* =========================================================
   SELECT REFERENCE IMAGES
========================================================= */

async function selectReferences(
  imageSet
) {
  const candidates =
    imageSet.images
      .filter(
        (img) =>
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
    candidates.length
      ? candidates
      : [
          imageSet.rank1
        ];

  const scored =
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

      scored.push({
        image,
        buffer,
        analysis,

        score:
          referenceScore(
            analysis,
            Number(
              image.rank ||
              99
            )
          )
      });

    } catch (error) {
      scored.push({
        image,

        error:
          error.message,

        score:
          -999
      });
    }
  }

  const usable =
    scored
      .filter(
        (x) =>
          x.buffer
      )
      .sort(
        (
          a,
          b
        ) =>
          b.score -
          a.score
      );

  if (
    !usable.length
  ) {
    throw new Error(
      'Could not obtain a usable reference image'
    );
  }

  return usable.slice(
    0,
    Math.min(
      2,
      usable.length
    )
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
Create a premium Etsy first-image thumbnail for the exact product shown in the reference image or images.

PRODUCT TITLE:
${title || 'Unknown title'}

WHY THIS THUMBNAIL IS BEING CREATED:
${reason}

NON-NEGOTIABLE PRODUCT IDENTITY RULES:
- The reference image is the product truth.
- Preserve the exact artwork/product identity, subject, composition, important elements, orientation and color identity.
- Do not redesign, repaint, reinterpret, simplify, remove, add, or invent artwork elements.
- Do not generate a different product.
- Do not add new text, captions, badges, labels, logos or watermarks.
- If the product itself contains a signature or brand mark, preserve it as part of the product rather than inventing a new one.

THUMBNAIL GOAL:
- Create a new, professional, high-converting Etsy hero thumbnail around the exact product.
- Make the product immediately understandable on a mobile screen.
- Use a tasteful premium presentation suitable for wall art / home decor when appropriate to the reference.
- Bright natural lighting, clean tonal separation, realistic shadows, and strong but not exaggerated contrast.
- The product should be the visual focus and occupy a large useful portion of the image.
- Avoid dark moody exposure that hides the product.
- Avoid HDR, over-saturation, clipped highlights, extreme color grading, clutter, or distracting props.
- Keep the product itself faithful to the reference; only the presentation environment may be newly created.
- Square Etsy-ready composition with safe central framing for thumbnail crops.

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

Previous quality check feedback to fix:
${retryNote}`
        : ''
    }`;

  const response =
    await ai()
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
          IMAGE_QUALITY,

        moderation:
          'auto'
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

  const raw =
    Buffer.from(
      b64,
      'base64'
    );

  return normalizeJpeg(
    raw,
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
        (buffer) =>
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

  const response =
    await ai()
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

            content: [
              {
                type:
                  'input_text',

                text:
                  `You are the final safety gate for an Etsy thumbnail replacement.
All images except the final image are reference product truth.
The final image is the generated candidate thumbnail.
Listing title: ${title || ''}
PASS only if the candidate clearly shows the same actual product/artwork, preserves important subject/composition/color identity, does not invent or replace product content, and is readable as a thumbnail. Presentation/background may differ. Be strict.`
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
            ]
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

  let semantic;

  try {
    semantic =
      JSON.parse(
        response
          .output_text ||
        '{}'
      );

  } catch {
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
        'Quality-control response could not be parsed.'
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

    db().set(
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
      `${required('PUBLIC_BASE_URL').replace(/\/$/, '')}/preview/worker/${token}`
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
    await db().get(
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
      (img) =>
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
      (img) =>
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

  const variationData =
    await etsyRequest(
      `/shops/${await getShopId()}/listings/${listingId}/variation-images`
    ).catch(
      () => ({
        results:
          []
      })
    );

  const usedByVariation =
    (
      variationData
        ?.results ||
      []
    ).some(
      (item) =>
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
          (img) =>
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
      (img) =>
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
            (img) =>
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

    const uploaded =
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

    let uploadedImageId =
      getImageId(
        uploaded
          ?.results
          ?.[0] ||
        uploaded
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
              (img) =>
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
            (img) =>
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
          (img) =>
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
            : 'uploaded_not_rank1',

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
    listing?.title
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
    existing
      ?.status ===
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
        exact?.title ||
        null,

      action:
        'skipped',

      reason:
        'current_rank1_was_already_published_by_worker',

      state:
        existing,

      etsy_modified:
        false
    };
  }

  if (
    !force &&
    existing &&
    String(
      existing
        .sourceImageId ||
      ''
    ) ===
    sourceImageId &&
    existing
      .status ===
      'preview_ready'
  ) {
    return {
      listing_id:
        Number(
          listingId
        ),

      exact_title:
        exact?.title ||
        null,

      action:
        'skipped',

      reason:
        'already_processed_for_current_rank1',

      state:
        existing,

      etsy_modified:
        false
    };
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
        exact?.title ||
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
      imageSet
    );

  const referenceImageIds =
    references.map(
      (ref) =>
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
          exact?.title ||
          '',

        references,

        reason:
          isNew
            ? 'New Etsy listing detected'
            : `Existing thumbnail quality score ${rank1Score}/100`,

        retryNote:
          attempt ===
          2
            ? qc
                ?.semantic
                ?.reason ||
              'Preserve the product identity more strictly and improve thumbnail readability.'
            : ''
      });

    qc =
      await qualityCheck({
        title:
          exact?.title ||
          '',

        referenceBuffers:
          references.map(
            (ref) =>
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
    !qc?.passed
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
        referenceImageIds
          .map(
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
        exact?.title ||
        null,

      action:
        'blocked',

      reason:
        'generated_thumbnail_failed_quality_gate',

      rank1_score:
        rank1Score,

      qc,

      etsy_modified:
        false
    };
  }

  const preview =
    await savePreview({
      listingId,

      title:
        exact?.title ||
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
        referenceImageIds
          .map(
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
        exact?.title ||
        null,

      action:
        'auto_published',

      reason,

      previous_rank1_score:
        rank1Score,

      preview_url:
        preview.previewUrl,

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
      exact?.title ||
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
        data?.results
      )
        ? data.results
        : [];

    total =
      Number(
        data?.count ??
        page.length
      );

    results.push(
      ...page
    );

    if (
      !page.length
    ) {
      break;
    }

    offset +=
      page.length;

    if (
      page.length <
      100
    ) {
      break;
    }
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
    await db().set(
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
    await db().get(
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
    await db().del(
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
        await db().get(
          `${PREFIX}:initialized`
        )
      );

    /*
      FIRST EVER RUN:
      mark all current listings as seen.
      This prevents every existing listing from being treated as "new".
      They will still be checked by rolling scan.
    */
    if (
      !initialized
    ) {
      if (
        listings.length
      ) {
        await db().sadd(
          `${PREFIX}:seen`,
          ...listings.map(
            (l) =>
              String(
                l.listing_id
              )
          )
        );
      }

      await db().set(
        `${PREFIX}:initialized`,
        '1'
      );

    } else {
      /*
        Later runs:
        unknown listing IDs are real new listings.
      */
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
            await db().sismember(
              `${PREFIX}:seen`,
              id
            )
          );

        if (
          !seen
        ) {
          await db().sadd(
            `${PREFIX}:seen`,
            id
          );

          await db().sadd(
            `${PREFIX}:pending-new`,
            id
          );
        }
      }
    }

    const byId =
      new Map(
        listings.map(
          (l) => [
            String(
              l.listing_id
            ),
            l
          ]
        )
      );

    const pending =
      (
        await db().smembers(
          `${PREFIX}:pending-new`
        )
      ).map(
        String
      );

    const selected =
      [];

    const selectedIds =
      new Set();

    /*
      New listings get first priority.
    */
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
        await db().srem(
          `${PREFIX}:pending-new`,
          id
        );
      }
    }

    /*
      Fill remaining batch with rolling store scan.
    */
    let cursor =
      Number(
        await db().get(
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
      await db().set(
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
          await db().srem(
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
            false
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
          await db().scard(
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
  async (
    _req,
    res
  ) => {
    res.json({
      ok:
        true,

      service:
        'vaelons-thumbnail-worker',

      version:
        '1.0.0',

      worker_mode:
        WORKER_MODE,

      image_model:
        IMAGE_MODEL,

      qa_model:
        QA_MODEL,

      safe_replace_order:
        'generate -> QA -> upload -> verify rank1 -> delete old'
    });
  }
);


/* =========================================================
   PUBLIC PREVIEW IMAGE
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
        await db().get(
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
   WORKER API AUTH
========================================================= */

app.use(
  '/api/worker',
  managerOrWorkerAuth
);


/* =========================================================
   WORKER STATUS
========================================================= */

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
          'vaelons-thumbnail-worker',

        version:
          '1.0.0',

        mode:
          WORKER_MODE,

        etsy:
          await getTokenStatus(),

        initialized:
          Boolean(
            await db().get(
              `${PREFIX}:initialized`
            )
          ),

        pending_new_count:
          Number(
            await db().scard(
              `${PREFIX}:pending-new`
            )
          ),

        scan_cursor:
          Number(
            await db().get(
              `${PREFIX}:scan-cursor`
            )
          ) ||
          0,

        auto_delete_old_rank1:
          AUTO_DELETE_OLD_RANK1,

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
   RUN WORKER
   GET = Vercel Cron
   POST = Manager/manual
========================================================= */

const workerRunHandler =
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
  workerRunHandler
);

app.post(
  '/api/worker/run',
  workerRunHandler
);


/* =========================================================
   MANUAL PREPARE
========================================================= */

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


/* =========================================================
   LISTING WORKER STATUS
========================================================= */

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


/* =========================================================
   MANUAL PUBLISH
========================================================= */

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

      const deleteOld =
        req.body
          ?.delete_old !==
        false;

      res.json(
        await publishPreview(
          preview,
          {
            deleteOld
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
          error.etsyModified ===
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
        `VAELONS Thumbnail Worker listening on :${port}`
      );
    }
  );
}
