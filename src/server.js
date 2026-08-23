import express from 'express';
import sharp from 'sharp';
import OpenAI, { toFile } from 'openai';
import { Redis } from '@upstash/redis';
import { randomBytes, createHash } from 'node:crypto';

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
  uploadListingImage,
  setListingImageRank,
  deleteListingImage
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
  'safe';

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

const COMPLIANCE_MODEL =
  process.env.OPENAI_COMPLIANCE_MODEL ||
  QA_MODEL;

const MAX_GENERATION_ATTEMPTS =
  clampInt(
    process.env.MAX_GENERATION_ATTEMPTS ||
    3,
    1,
    5
  );

const IMAGE_SIZE =
  process.env.OPENAI_IMAGE_SIZE ||
  '1024x1024';

const IMAGE_QUALITY =
  process.env.OPENAI_IMAGE_QUALITY ||
  'high';

const RECENT_SCENE_HISTORY_LIMIT =
  12;

const RECENT_QA_COMPARISON_LIMIT =
  3;

const SCENE_FAMILIES = [
  {
    id: 'museum_wall',
    label: 'Museum Minimal Wall',
    description:
      'A nearly furniture-free museum wall with refined plaster or mineral texture and soft neutral daylight.',
    architecture:
      'quiet museum wall, clean ceiling line, premium mineral plaster, no shelving',
    camera:
      'straight-on editorial camera, eye-level, restrained perspective, artwork centered and large',
    foreground_policy:
      'empty floor or a single slim museum bench kept low and far below the artwork',
    decor_signature:
      'museum_wall+zero_decor',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, styled shelves, tabletop decor, bowls, candles, sculptures or decorative clusters outside the artwork.'
  },
  {
    id: 'bright_gallery',
    label: 'Bright Contemporary Gallery',
    description:
      'A bright contemporary gallery bay with generous negative space and crisp neutral daylight.',
    architecture:
      'white or pale-stone gallery bay, subtle reveal joints, no built-in shelving',
    camera:
      'slightly off-axis gallery photograph, clean verticals, artwork remains the dominant plane',
    foreground_policy:
      'bare floor; optional narrow gallery bench only, with nothing placed on it',
    decor_signature:
      'gallery_bay+bare_floor',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, styled shelves or tabletop decor outside the artwork.'
  },
  {
    id: 'stone_niche',
    label: 'Architectural Stone Niche',
    description:
      'A pale limestone or lime-plaster architectural niche designed around one large artwork.',
    architecture:
      'monolithic pale stone niche, soft shadow reveal, one clean architectural opening',
    camera:
      'front three-quarter architectural camera with mild depth and perfectly controlled verticals',
    foreground_policy:
      'nothing below the artwork except an empty integrated stone plinth if composition requires it',
    decor_signature:
      'stone_niche+empty_plinth',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, shelves, tabletop decor or accessory styling outside the artwork.'
  },
  {
    id: 'architectural_hall',
    label: 'Daylight Architectural Hall',
    description:
      'A bright architectural corridor or softly arched hall with museum-like presentation and no decorative styling.',
    architecture:
      'soft arches or long corridor, pale plaster and stone, clean daylight from one side',
    camera:
      'long-lens architectural framing with subtle depth; artwork large on the hero wall',
    foreground_policy:
      'bare circulation space; no furniture directly under the artwork',
    decor_signature:
      'architectural_hall+bare',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, credenzas, styled shelves, tables with objects or decorative clusters outside the artwork.'
  },
  {
    id: 'daylight_loft',
    label: 'Daylight Collector Loft',
    description:
      'A clean high-ceiling collector loft with one large artwork on an uninterrupted neutral wall.',
    architecture:
      'high ceiling, large daylight opening off-frame, pale concrete or soft plaster wall',
    camera:
      'wide but controlled editorial camera; enough room context to feel premium without shrinking the artwork',
    foreground_policy:
      'one low neutral seat may enter the bottom edge; all surfaces remain bare',
    decor_signature:
      'collector_loft+bare_surfaces',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, styled shelves or tabletop decor outside the artwork.'
  },
  {
    id: 'quiet_entry',
    label: 'Quiet Entry Gallery',
    description:
      'A high-end entry gallery with strong daylight and one artwork as the sole visual focal point.',
    architecture:
      'clean entry wall, pale stone floor, subtle doorway or passage for depth',
    camera:
      'eye-level symmetrical or near-symmetrical camera; artwork fills the main wall',
    foreground_policy:
      'optional plain upholstered bench only; no console and nothing placed on furniture',
    decor_signature:
      'entry_gallery+plain_bench',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, styled shelves or tabletop decor outside the artwork.'
  },
  {
    id: 'airy_living',
    label: 'Airy Living Wall',
    description:
      'A refined daylight living space where only a low neutral sofa edge is visible and the artwork dominates.',
    architecture:
      'open neutral wall, soft natural daylight, no shelving or display cabinetry',
    camera:
      'straight or slight three-quarter residential editorial camera with minimal foreground',
    foreground_policy:
      'low sofa edge only; no coffee table, side table, console or accessories',
    decor_signature:
      'living_wall+sofa_edge_only',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, shelves, coffee-table decor, side-table decor or decorative clusters outside the artwork.'
  },
  {
    id: 'calm_bedroom',
    label: 'Calm Bedroom Wall',
    description:
      'A serene neutral bedroom with only a low headboard or bedding edge visible beneath a large artwork.',
    architecture:
      'quiet plaster bedroom wall, neutral textile edge, clean daylight',
    camera:
      'restrained straight-on editorial camera, artwork large above a low headboard line',
    foreground_policy:
      'headboard or bedding only; no nightstand objects, lamps, books, plants or accessories',
    decor_signature:
      'bedroom_wall+bed_edge_only',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, styled shelves, nightstand decor or tabletop decor outside the artwork.'
  },
  {
    id: 'stair_landing',
    label: 'Sculptural Stair Landing',
    description:
      'A bright minimal stair landing with a single hero artwork on a tall neutral wall.',
    architecture:
      'pale stone stair or floating stair edge, tall plaster wall, daylight from above or side',
    camera:
      'architectural three-quarter camera using stair geometry for depth while keeping artwork unobstructed',
    foreground_policy:
      'stairs and bare floor only',
    decor_signature:
      'stair_landing+zero_decor',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, styled shelves, tables or decorative objects outside the artwork.'
  },
  {
    id: 'collector_pavilion',
    label: 'Collector Pavilion',
    description:
      'A silent monolithic collector pavilion where architecture exists to display one artwork.',
    architecture:
      'travertine or limestone wall, restrained reveal lighting, monumental opening or soft courtyard light',
    camera:
      'museum-grade architectural photograph, calm geometry, artwork visually dominant',
    foreground_policy:
      'empty stone floor; no residential decoration',
    decor_signature:
      'collector_pavilion+empty',
    forbidden:
      'ZERO plants, planters, pots, vases, urns, branches, books, magazines, consoles, sideboards, credenzas, shelving, tables or decorative objects outside the artwork.'
  }
];


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
   ARTWORK REFERENCE ISOLATION
========================================================= */

function clamp01(value) {
  return Math.max(
    0,
    Math.min(
      1,
      Number(value) || 0
    )
  );
}

function sanitizeNormalizedBox({
  x,
  y,
  width,
  height
}) {
  const sx =
    clamp01(x);

  const sy =
    clamp01(y);

  const sw =
    Math.max(
      0,
      Math.min(
        1 - sx,
        Number(width) || 0
      )
    );

  const sh =
    Math.max(
      0,
      Math.min(
        1 - sy,
        Number(height) || 0
      )
    );

  if (
    sw <= 0 ||
    sh <= 0
  ) {
    return null;
  }

  return {
    x:
      sx,

    y:
      sy,

    width:
      sw,

    height:
      sh
  };
}

async function cropNormalizedBox(
  buffer,
  box,
  {
    maxSize = 1800,
    quality = 95
  } = {}
) {
  const safeBox =
    sanitizeNormalizedBox(
      box
    );

  if (!safeBox) {
    throw new Error(
      'Invalid normalized crop box'
    );
  }

  const metadata =
    await sharp(
      buffer
    ).metadata();

  const sourceWidth =
    Number(
      metadata.width ||
      0
    );

  const sourceHeight =
    Number(
      metadata.height ||
      0
    );

  if (
    sourceWidth < 2 ||
    sourceHeight < 2
  ) {
    throw new Error(
      'Reference image has invalid dimensions'
    );
  }

  const left =
    Math.max(
      0,
      Math.min(
        sourceWidth - 1,
        Math.floor(
          safeBox.x *
          sourceWidth
        )
      )
    );

  const top =
    Math.max(
      0,
      Math.min(
        sourceHeight - 1,
        Math.floor(
          safeBox.y *
          sourceHeight
        )
      )
    );

  const width =
    Math.max(
      1,
      Math.min(
        sourceWidth - left,
        Math.round(
          safeBox.width *
          sourceWidth
        )
      )
    );

  const height =
    Math.max(
      1,
      Math.min(
        sourceHeight - top,
        Math.round(
          safeBox.height *
          sourceHeight
        )
      )
    );

  return sharp(
    buffer
  )
    .extract({
      left,
      top,
      width,
      height
    })
    .resize({
      width:
        maxSize,
      height:
        maxSize,
      fit:
        'inside',
      withoutEnlargement:
        true
    })
    .jpeg({
      quality,
      mozjpeg:
        true
    })
    .toBuffer();
}

async function maskNormalizedBox(
  buffer,
  box,
  {
    maxSize = 1300,
    quality = 90
  } = {}
) {
  const safeBox =
    sanitizeNormalizedBox(
      box
    );

  if (!safeBox) {
    throw new Error(
      'Invalid normalized mask box'
    );
  }

  const metadata =
    await sharp(
      buffer
    ).metadata();

  const sourceWidth =
    Number(
      metadata.width ||
      0
    );

  const sourceHeight =
    Number(
      metadata.height ||
      0
    );

  if (
    sourceWidth < 2 ||
    sourceHeight < 2
  ) {
    throw new Error(
      'Image has invalid dimensions for masking'
    );
  }

  const left =
    Math.max(
      0,
      Math.min(
        sourceWidth - 1,
        Math.floor(
          safeBox.x *
          sourceWidth
        )
      )
    );

  const top =
    Math.max(
      0,
      Math.min(
        sourceHeight - 1,
        Math.floor(
          safeBox.y *
          sourceHeight
        )
      )
    );

  const width =
    Math.max(
      1,
      Math.min(
        sourceWidth - left,
        Math.ceil(
          safeBox.width *
          sourceWidth
        )
      )
    );

  const height =
    Math.max(
      1,
      Math.min(
        sourceHeight - top,
        Math.ceil(
          safeBox.height *
          sourceHeight
        )
      )
    );

  const svg =
    Buffer.from(
      `<svg width="${sourceWidth}" height="${sourceHeight}" xmlns="http://www.w3.org/2000/svg"><rect x="${left}" y="${top}" width="${width}" height="${height}" fill="#b8b8b8"/></svg>`
    );

  return sharp(
    buffer
  )
    .composite([
      {
        input:
          svg,

        blend:
          'over'
      }
    ])
    .resize({
      width:
        maxSize,
      height:
        maxSize,
      fit:
        'inside',
      withoutEnlargement:
        true
    })
    .jpeg({
      quality,
      mozjpeg:
        true
    })
    .toBuffer();
}


async function collectArtworkCandidates(
  imageSet
) {
  const sourceImages =
    imageSet.images
      .filter(
        (image) =>
          getImageUrl(
            image
          )
      )
      .slice(
        0,
        8
      );

  const candidates =
    [];

  for (
    const image of
    sourceImages
  ) {
    try {
      const buffer =
        await downloadImage(
          getImageUrl(
            image
          )
        );

      const normalized =
        await normalizeJpeg(
          buffer,
          1400,
          90
        );

      candidates.push({
        image,

        imageId:
          getImageId(
            image
          ),

        rank:
          Number(
            image.rank ||
            99
          ),

        buffer:
          normalized
      });

    } catch (
      error
    ) {
      console.warn(
        'Artwork isolation candidate failed:',
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
      'ARTWORK_REFERENCE_ISOLATION_FAILED: no usable listing images'
    );
  }

  return candidates;
}

async function isolateArtworkReferences(
  title,
  imageSet
) {
  const candidates =
    await collectArtworkCandidates(
      imageSet
    );

  const content = [
    {
      type:
        'input_text',

      text:
        `You are isolating the ACTUAL wall-art product from Etsy listing images.

Listing title:
${title || ''}

The listing images may be lifestyle mockups. Room furniture and decor are NEVER product truth.

For each candidate, locate the visible rectangular ARTWORK/CANVAS IMAGE SURFACE itself.
- Exclude wall, frame shadow, console, table, sofa, plant, vase, books, shelves and room decor.
- If the candidate is a flat/direct artwork image, the box may cover almost the full image.
- Prefer the clearest, most complete, least-obstructed artwork surface.
- Select one primary crop and optionally one secondary crop only when it adds genuine product detail.
- Reject a crop if the artwork is too tiny, severely angled, blocked, or uncertain.

Return normalized coordinates from 0 to 1.`
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
        `data:image/jpeg;base64,${candidate.buffer.toString('base64')}`,

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
      'primary_x',
      'primary_y',
      'primary_width',
      'primary_height',
      'primary_direct_artwork',
      'primary_confidence',
      'use_secondary',
      'secondary_index',
      'secondary_x',
      'secondary_y',
      'secondary_width',
      'secondary_height',
      'secondary_direct_artwork',
      'secondary_confidence',
      'reason'
    ],

    properties: {
      primary_index: {
        type:
          'integer'
      },

      primary_x: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      primary_y: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      primary_width: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      primary_height: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      primary_direct_artwork: {
        type:
          'boolean'
      },

      primary_confidence: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      use_secondary: {
        type:
          'boolean'
      },

      secondary_index: {
        type:
          'integer'
      },

      secondary_x: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      secondary_y: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      secondary_width: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      secondary_height: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      secondary_direct_artwork: {
        type:
          'boolean'
      },

      secondary_confidence: {
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

  let parsed;

  try {
    const response =
      await openai()
        .responses
        .create({
          model:
            COMPLIANCE_MODEL,

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
                'vaelons_artwork_isolation_v1',

              strict:
                true,

              schema
            }
          }
        });

    parsed =
      JSON.parse(
        response.output_text ||
        '{}'
      );

  } catch (
    error
  ) {
    console.warn(
      'Artwork reference isolation failed:',
      error.message
    );

    throw new Error(
      `ARTWORK_REFERENCE_ISOLATION_FAILED: ${error.message}`
    );
  }

  const specs = [
    {
      index:
        Number(
          parsed.primary_index
        ),

      box: {
        x:
          parsed.primary_x,

        y:
          parsed.primary_y,

        width:
          parsed.primary_width,

        height:
          parsed.primary_height
      },

      directArtwork:
        parsed.primary_direct_artwork ===
        true,

      confidence:
        Number(
          parsed.primary_confidence ||
          0
        )
    }
  ];

  if (
    parsed.use_secondary ===
      true
  ) {
    specs.push({
      index:
        Number(
          parsed.secondary_index
        ),

      box: {
        x:
          parsed.secondary_x,

        y:
          parsed.secondary_y,

        width:
          parsed.secondary_width,

        height:
          parsed.secondary_height
      },

      directArtwork:
        parsed.secondary_direct_artwork ===
        true,

      confidence:
        Number(
          parsed.secondary_confidence ||
          0
        )
    });
  }

  const selected =
    [];

  const usedIndices =
    new Set();

  for (
    const spec of
    specs
  ) {
    if (
      !Number.isInteger(
        spec.index
      ) ||
      spec.index <
        0 ||
      spec.index >=
        candidates.length ||
      usedIndices.has(
        spec.index
      )
    ) {
      continue;
    }

    const safeBox =
      sanitizeNormalizedBox(
        spec.box
      );

    const area =
      safeBox
        ? safeBox.width *
          safeBox.height
        : 0;

    if (
      !safeBox ||
      area <
        0.08 ||
      spec.confidence <
        0.72
    ) {
      continue;
    }

    const candidate =
      candidates[
        spec.index
      ];

    const cropped =
      await cropNormalizedBox(
        candidate.buffer,
        safeBox,
        {
          maxSize:
            1800,

          quality:
            96
        }
      );

    selected.push({
      image:
        candidate.image,

      imageId:
        candidate.imageId,

      rank:
        candidate.rank,

      buffer:
        cropped,

      isolation: {
        box:
          safeBox,

        direct_artwork:
          spec.directArtwork,

        confidence:
          spec.confidence,

        selector_reason:
          parsed.reason ||
          null
      }
    });

    usedIndices.add(
      spec.index
    );
  }

  if (
    !selected.length
  ) {
    throw new Error(
      'ARTWORK_REFERENCE_ISOLATION_FAILED: no high-confidence artwork crop'
    );
  }

  return selected.slice(
    0,
    2
  );
}


/* =========================================================
   ARTWORK-AWARE SCENE PLANNER
========================================================= */

function sceneHistoryKey() {
  return `${PREFIX}:scene-history`;
}

function stableNumber(value) {
  const hex =
    createHash('sha256')
      .update(String(value || ''))
      .digest('hex')
      .slice(0, 8);

  return Number.parseInt(hex, 16) || 0;
}

async function getRecentSceneHistory(
  limit = RECENT_SCENE_HISTORY_LIMIT
) {
  const rows =
    await redis().lrange(
      sceneHistoryKey(),
      0,
      Math.max(0, limit - 1)
    );

  return (rows || [])
    .map((row) => {
      if (
        row &&
        typeof row === 'object'
      ) {
        return row;
      }

      try {
        return JSON.parse(String(row));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function addSceneHistory(item) {
  await redis().lpush(
    sceneHistoryKey(),
    JSON.stringify({
      ...item,
      recorded_at:
        Date.now()
    })
  );

  await redis().ltrim(
    sceneHistoryKey(),
    0,
    49
  );
}

async function loadRecentGeneratedComparisons({
  listingId,
  limit = RECENT_QA_COMPARISON_LIMIT
} = {}) {
  const history =
    await getRecentSceneHistory(
      Math.max(
        limit * 6,
        18
      )
    );

  const targetListingId =
    listingId
      ? String(
          listingId
        )
      : null;

  const orderedHistory = [
    ...(
      targetListingId
        ? history.filter(
            (item) =>
              String(
                item?.listing_id ||
                ''
              ) ===
              targetListingId
          )
        : []
    ),

    ...history.filter(
      (item) =>
        !targetListingId ||
        String(
          item?.listing_id ||
          ''
        ) !==
        targetListingId
    )
  ];

  const result = [];
  const usedTokens = new Set();

  for (
    const item of
    orderedHistory
  ) {
    if (
      result.length >= limit
    ) {
      break;
    }

    const token =
      String(
        item?.preview_token ||
        ''
      );

    if (
      !token ||
      usedTokens.has(token)
    ) {
      continue;
    }

    const base64 =
      await redis().get(
        previewImageKey(token)
      );

    if (!base64) {
      continue;
    }

    try {
      result.push({
        listing_id:
          item?.listing_id ||
          null,

        scene_family:
          item?.scene_family ||
          null,

        decor_signature:
          item?.decor_signature ||
          null,

        observed_architecture:
          item?.observed_architecture ||
          null,

        layout_signature:
          item?.layout_signature ||
          null,

        buffer:
          Buffer.from(
            String(base64),
            'base64'
          )
      });

      usedTokens.add(token);
    } catch {
      // Ignore stale/corrupt comparison entries.
    }
  }

  return result;
}

async function analyzeArtworkContext({
  title,
  references
}) {
  const referenceImages =
    await Promise.all(
      references.map(
        (ref) =>
          normalizeJpeg(
            ref.buffer,
            1200,
            90
          )
      )
    );

  const allowedSceneIds =
    SCENE_FAMILIES.map(
      (item) => item.id
    );

  const schema = {
    type:
      'object',

    additionalProperties:
      false,

    required: [
      'artwork_subject',
      'artwork_style',
      'visual_mood',
      'palette',
      'orientation',
      'recommended_scene_families',
      'must_preserve',
      'avoid_environment_elements',
      'confidence'
    ],

    properties: {
      artwork_subject: {
        type:
          'string'
      },

      artwork_style: {
        type:
          'string'
      },

      visual_mood: {
        type:
          'string'
      },

      palette: {
        type:
          'array',

        items: {
          type:
            'string'
        },

        maxItems:
          8
      },

      orientation: {
        type:
          'string',

        enum: [
          'portrait',
          'landscape',
          'square',
          'unknown'
        ]
      },

      recommended_scene_families: {
        type:
          'array',

        items: {
          type:
            'string',

          enum:
            allowedSceneIds
        },

        minItems:
          3,

        maxItems:
          6
      },

      must_preserve: {
        type:
          'array',

        items: {
          type:
            'string'
        },

        maxItems:
          10
      },

      avoid_environment_elements: {
        type:
          'array',

        items: {
          type:
            'string'
        },

        maxItems:
          10
      },

      confidence: {
        type:
          'number',

        minimum:
          0,

        maximum:
          1
      }
    }
  };

  const content = [
    {
      type:
        'input_text',

      text:
        `You are planning a premium Etsy wall-art hero scene.

Listing title:
${title || ''}

The supplied images are isolated artwork/product crops. Analyze the ACTUAL ARTWORK/PRODUCT only; surrounding room staging has already been removed.

Your job is to describe the artwork and recommend several scene families that fit it without changing the artwork.

Important:
- Different artworks should produce different presentation choices.
- Scene recommendations must support a ZERO-DECOR environment: no plant, planter, pot, vase, urn, books, console, styled shelving or tabletop accessories outside the artwork.
- Prefer bright neutral daylight presentation.
- A warm/sunset artwork may remain warm INSIDE the artwork, but the generated room/environment should stay neutral rather than yellow/amber.
- Preserve subject identity, composition, orientation, visible signatures/text that belong to the artwork, and color identity.

Available scene family IDs:
${SCENE_FAMILIES.map((item) => `${item.id}: ${item.description}`).join('\n')}`
    },

    ...referenceImages.map(
      (image) => ({
        type:
          'input_image',

        image_url:
          `data:image/jpeg;base64,${image.toString('base64')}`,

        detail:
          'high'
      })
    )
  ];

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
                'vaelons_artwork_context',

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

    return {
      ...parsed,

      recommended_scene_families:
        Array.isArray(
          parsed?.recommended_scene_families
        )
          ? parsed.recommended_scene_families.filter(
              (id) =>
                allowedSceneIds.includes(id)
            )
          : allowedSceneIds.slice(0, 5)
    };

  } catch (
    error
  ) {
    console.warn(
      'Artwork context fallback:',
      error.message
    );

    return {
      artwork_subject:
        title ||
        'wall art',

      artwork_style:
        'unknown',

      visual_mood:
        'unknown',

      palette:
        [],

      orientation:
        'unknown',

      recommended_scene_families:
        allowedSceneIds,

      must_preserve:
        [
          'exact artwork identity',
          'subject and composition',
          'orientation and color identity'
        ],

      avoid_environment_elements:
        [],

      confidence:
        0
    };
  }
}

function chooseScenePlan({
  listingId,
  title,
  artworkContext,
  recentHistory,
  extraExcluded = []
}) {
  const allIds =
    SCENE_FAMILIES.map(
      (item) => item.id
    );

  const preferred =
    Array.from(
      new Set([
        ...(
          Array.isArray(
            artworkContext
              ?.recommended_scene_families
          )
            ? artworkContext
                .recommended_scene_families
            : []
        ),
        ...allIds
      ])
    ).filter(
      (id) =>
        allIds.includes(id)
    );

  const targetListingId =
    String(
      listingId ||
      ''
    );

  const sameListingIds =
    (recentHistory || [])
      .filter(
        (item) =>
          String(
            item?.listing_id ||
            ''
          ) ===
          targetListingId
      )
      .map(
        (item) =>
          String(
            item?.scene_family ||
            ''
          )
      )
      .filter(Boolean);

  const recentIds =
    (recentHistory || [])
      .map(
        (item) =>
          String(
            item?.scene_family ||
            ''
          )
      )
      .filter(Boolean);

  const excluded =
    new Set([
      ...sameListingIds.slice(0, 3),
      ...recentIds.slice(0, 5),
      ...extraExcluded.map(String)
    ]);

  let choices =
    preferred.filter(
      (id) =>
        !excluded.has(id)
    );

  if (!choices.length) {
    const counts =
      new Map(
        allIds.map(
          (id) => [id, 0]
        )
      );

    for (
      const id of
      recentIds
    ) {
      counts.set(
        id,
        (counts.get(id) || 0) + 1
      );
    }

    choices = [
      ...preferred
    ].sort(
      (a, b) =>
        (counts.get(a) || 0) -
        (counts.get(b) || 0)
    ).filter(
      (id) =>
        !extraExcluded.includes(id)
    );
  }

  if (!choices.length) {
    choices =
      preferred;
  }

  const seed =
    stableNumber(
      `${listingId}:${title}:${Date.now()}:${extraExcluded.join(',')}`
    );

  const sceneId =
    choices[
      seed %
      choices.length
    ];

  const family =
    SCENE_FAMILIES.find(
      (item) =>
        item.id === sceneId
    ) ||
    SCENE_FAMILIES[0];

  const recentDecor =
    Array.from(
      new Set(
        (recentHistory || [])
          .slice(0, 12)
          .map(
            (item) =>
              item?.layout_signature ||
              item?.decor_signature
          )
          .filter(Boolean)
      )
    );

  return {
    scene_family:
      family.id,

    scene_label:
      family.label,

    scene_description:
      family.description,

    architecture:
      family.architecture,

    camera:
      family.camera,

    foreground_policy:
      family.foreground_policy,

    decor_signature:
      family.decor_signature,

    family_forbidden:
      family.forbidden,

    recent_scene_families:
      recentIds.slice(0, 10),

    same_listing_scene_families:
      sameListingIds.slice(0, 6),

    recent_decor_signatures:
      recentDecor,

    artwork_subject:
      artworkContext
        ?.artwork_subject ||
      title ||
      'wall art',

    artwork_style:
      artworkContext
        ?.artwork_style ||
      'unknown',

    visual_mood:
      artworkContext
        ?.visual_mood ||
      'unknown',

    palette:
      artworkContext
        ?.palette ||
      [],

    must_preserve:
      artworkContext
        ?.must_preserve ||
      [],

    avoid_environment_elements:
      artworkContext
        ?.avoid_environment_elements ||
      []
  };
}


/* =========================================================
   GENERATION PROMPT
========================================================= */

function buildGenerationPrompt({
  title,
  reason,
  scenePlan
}) {
  return `
Create a premium Etsy FIRST-IMAGE hero thumbnail around the exact isolated artwork/product shown in the supplied reference crop or crops.

LISTING TITLE:
${title || 'Unknown'}

WHY A NEW THUMBNAIL IS NEEDED:
${reason}

ARTWORK-AWARE SCENE PLAN — FOLLOW IT LITERALLY:
- Scene family: ${scenePlan?.scene_label || scenePlan?.scene_family || 'museum minimal'}
- Direction: ${scenePlan?.scene_description || ''}
- Architecture: ${scenePlan?.architecture || ''}
- Camera: ${scenePlan?.camera || ''}
- Foreground policy: ${scenePlan?.foreground_policy || ''}
- Artwork subject: ${scenePlan?.artwork_subject || ''}
- Artwork style: ${scenePlan?.artwork_style || ''}
- Visual mood: ${scenePlan?.visual_mood || ''}
- Artwork palette: ${JSON.stringify(scenePlan?.palette || [])}
- Preserve especially: ${JSON.stringify(scenePlan?.must_preserve || [])}
- Avoid for this artwork/environment: ${JSON.stringify(scenePlan?.avoid_environment_elements || [])}

ZERO-TOLERANCE STAGING RULES — OUTSIDE THE ARTWORK:
- NO potted plant, indoor tree, planter, flower pot or plant cluster.
- NO vase, urn, ceramic vessel, decorative bottle or branch arrangement.
- NO books, stacked books, magazines, catalogues or coffee-table books.
- NO console, credenza, sideboard, cabinet or floating console beneath the artwork.
- NO styled shelving or shelf decor.
- NO tabletop styling or decorative object cluster: no bowl, tray, candle, sculpture, vase, books or accessories on any table/bench/surface.
- Do not recreate the familiar beige-room + console + vase/branches + books formula in any form.
- Family-specific prohibition: ${scenePlan?.family_forbidden || ''}

ANTI-REPETITION MEMORY:
- Same-listing scene families already used: ${JSON.stringify(scenePlan?.same_listing_scene_families || [])}
- Recent scene families already used: ${JSON.stringify(scenePlan?.recent_scene_families || [])}
- Recent observed layout signatures: ${JSON.stringify(scenePlan?.recent_decor_signatures || [])}
- The new architecture, camera, wall geometry and foreground silhouette must be visibly different from recent previews.
- Do not imitate a generic stock wall-art mockup.

PRODUCT TRUTH — NON-NEGOTIABLE:
- The supplied image references are isolated crops of the actual artwork/product.
- Reproduce that exact artwork identity inside the new presentation.
- Preserve subject, important composition, important elements, orientation/aspect ratio, visible artwork text/signature and color identity.
- Do not redesign, repaint, reinterpret, simplify, add, remove, crop away, stretch, warp or invent artwork/product content.
- Do not substitute a similar artwork or different product.
- Do not create new text, badges, labels, logos, signatures or watermarks.
- If the artwork itself naturally contains plants, vases, books, text or warm colors, preserve them INSIDE the artwork. The zero-tolerance rules apply only to the generated environment OUTSIDE the artwork.

PRESENTATION:
- Artwork/product must be LARGE and visually dominant: target roughly 50–72% of the hero area when practical.
- Keep the complete product understandable on a mobile Etsy thumbnail.
- Use bright neutral daylight and premium realistic materials with clean tonal separation.
- Environment color must stay neutral white, cream, pale stone, soft beige or soft grey without yellow/orange/amber room cast.
- Warmth that belongs to the artwork stays inside the artwork.
- Avoid dark cinematic rooms, tungsten lighting, heavy HDR, haze, clipped highlights, excessive saturation and clutter.
- Use a square Etsy-ready composition with safe margins.
- The result must look intentionally designed for THIS artwork and visibly unlike previous VAELONS room templates.

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
  scenePlan,
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
      reason,
      scenePlan
    })}${
      retryNote
        ? `

QUALITY-CHECK FEEDBACK FROM THE PREVIOUS ATTEMPT:
${retryNote}

This is a regeneration. Correct every cited issue. If the previous result looked generic or repeated a recent room, the new result MUST visibly use the newly supplied scene plan. Preserve the exact product identity.`
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

  if (!b64) {
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
   HARD STAGING + ARTWORK IDENTITY QUALITY GATES
========================================================= */

async function inspectStagingCompliance({
  generatedBuffer,
  scenePlan,
  recentGenerated = []
}) {
  const generated =
    await normalizeJpeg(
      generatedBuffer,
      1300,
      92
    );

  const comparisons =
    await Promise.all(
      recentGenerated
        .slice(
          0,
          5
        )
        .map(
          async (
            item
          ) => ({
            ...item,

            normalized:
              await normalizeJpeg(
                item.buffer,
                850,
                80
              )
          })
        )
    );

  const schema = {
    type:
      'object',

    additionalProperties:
      false,

    required: [
      'pass',
      'artwork_dominant',
      'planned_scene_match',
      'potted_plant',
      'loose_plant_or_indoor_tree',
      'vase_urn_planter',
      'decorative_branches',
      'books_or_magazines',
      'console_sideboard_credenza',
      'styled_shelving',
      'tabletop_decor',
      'decor_cluster',
      'extra_wall_art',
      'generic_mockup',
      'repeated_layout',
      'repeated_decor_formula',
      'warm_room_cast',
      'artwork_bbox_x',
      'artwork_bbox_y',
      'artwork_bbox_width',
      'artwork_bbox_height',
      'artwork_bbox_confidence',
      'observed_architecture',
      'layout_signature',
      'confidence',
      'reason'
    ],

    properties: {
      pass: {
        type:
          'boolean'
      },

      artwork_dominant: {
        type:
          'boolean'
      },

      planned_scene_match: {
        type:
          'boolean'
      },

      potted_plant: {
        type:
          'boolean'
      },

      loose_plant_or_indoor_tree: {
        type:
          'boolean'
      },

      vase_urn_planter: {
        type:
          'boolean'
      },

      decorative_branches: {
        type:
          'boolean'
      },

      books_or_magazines: {
        type:
          'boolean'
      },

      console_sideboard_credenza: {
        type:
          'boolean'
      },

      styled_shelving: {
        type:
          'boolean'
      },

      tabletop_decor: {
        type:
          'boolean'
      },

      decor_cluster: {
        type:
          'boolean'
      },

      extra_wall_art: {
        type:
          'boolean'
      },

      generic_mockup: {
        type:
          'boolean'
      },

      repeated_layout: {
        type:
          'boolean'
      },

      repeated_decor_formula: {
        type:
          'boolean'
      },

      warm_room_cast: {
        type:
          'boolean'
      },

      artwork_bbox_x: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      artwork_bbox_y: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      artwork_bbox_width: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      artwork_bbox_height: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      artwork_bbox_confidence: {
        type:
          'number',
        minimum:
          0,
        maximum:
          1
      },

      observed_architecture: {
        type:
          'string'
      },

      layout_signature: {
        type:
          'string'
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
        `You are a ZERO-TOLERANCE staging compliance inspector for an Etsy wall-art hero.

Inspect ONLY the generated ENVIRONMENT OUTSIDE the artwork when judging forbidden decor.
If the artwork image itself depicts plants, vases, books, text or warm colors, IGNORE those internal artwork elements.

Planned scene:
${JSON.stringify({
  scene_family:
    scenePlan?.scene_family,
  scene_description:
    scenePlan?.scene_description,
  architecture:
    scenePlan?.architecture,
  camera:
    scenePlan?.camera,
  foreground_policy:
    scenePlan?.foreground_policy
})}

Hard fail if ANY of these appear outside the artwork:
- any potted plant, indoor tree, planter or flower pot
- any vase, urn or decorative vessel
- any decorative branch arrangement
- any book, book stack, magazine or coffee-table book
- any console, sideboard or credenza beneath/near the artwork
- any styled shelf or shelf decor
- any tabletop/bench/surface decor such as bowls, trays, candles, sculptures, books, vases or accessory clusters
- extra wall art competing with the product
- the familiar generic wall-art mockup formula or a substantially repeated recent layout
- yellow/orange/amber room lighting or color cast

Also locate the actual displayed artwork surface in the FINAL candidate and return a normalized bounding box from 0 to 1.
The box should cover the artwork image/canvas face, not the surrounding wall or furniture.

PASS only if the candidate matches the planned architecture, the artwork is dominant, none of the hard-fail elements exist, the environment is neutral, and confidence is high.`
    }
  ];

  if (
    comparisons.length
  ) {
    content.push({
      type:
        'input_text',

      text:
        'RECENT GENERATED HEROES — use only to detect repeated staging/layout:'
    });

    for (
      const item of
      comparisons
    ) {
      content.push({
        type:
          'input_text',

        text:
          `Recent listing ${item.listing_id || 'unknown'}; scene ${item.scene_family || 'unknown'}; layout ${item.layout_signature || item.decor_signature || 'unknown'}`
      });

      content.push({
        type:
          'input_image',

        image_url:
          `data:image/jpeg;base64,${item.normalized.toString('base64')}`,

        detail:
          'low'
      });
    }
  }

  content.push({
    type:
      'input_text',

    text:
      'FINAL GENERATED CANDIDATE:'
  });

  content.push({
    type:
      'input_image',

    image_url:
      `data:image/jpeg;base64,${generated.toString('base64')}`,

    detail:
      'high'
  });

  let result;

  try {
    const response =
      await openai()
        .responses
        .create({
          model:
            COMPLIANCE_MODEL,

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
                'vaelons_staging_gate_v2',

              strict:
                true,

              schema
            }
          }
        });

    result =
      JSON.parse(
        response.output_text ||
        '{}'
      );

  } catch (
    error
  ) {
    return {
      passed:
        false,

      semantic: {
        pass:
          false,

        confidence:
          0,

        reason:
          `Staging compliance request failed: ${error.message}`
      },

      artwork_box:
        null
    };
  }

  const artworkBox =
    sanitizeNormalizedBox({
      x:
        result.artwork_bbox_x,

      y:
        result.artwork_bbox_y,

      width:
        result.artwork_bbox_width,

      height:
        result.artwork_bbox_height
    });

  const artworkArea =
    artworkBox
      ? artworkBox.width *
        artworkBox.height
      : 0;

  const forbiddenDetected =
    result.potted_plant ===
      true ||
    result.loose_plant_or_indoor_tree ===
      true ||
    result.vase_urn_planter ===
      true ||
    result.decorative_branches ===
      true ||
    result.books_or_magazines ===
      true ||
    result.console_sideboard_credenza ===
      true ||
    result.styled_shelving ===
      true ||
    result.tabletop_decor ===
      true ||
    result.decor_cluster ===
      true ||
    result.extra_wall_art ===
      true;

  const passed =
    result.pass ===
      true &&
    result.artwork_dominant ===
      true &&
    result.planned_scene_match ===
      true &&
    forbiddenDetected ===
      false &&
    result.generic_mockup ===
      false &&
    result.repeated_layout ===
      false &&
    result.repeated_decor_formula ===
      false &&
    result.warm_room_cast ===
      false &&
    Number(
      result.confidence ||
      0
    ) >=
      0.88 &&
    Number(
      result.artwork_bbox_confidence ||
      0
    ) >=
      0.82 &&
    artworkArea >=
      0.18;

  return {
    passed,

    forbidden_detected:
      forbiddenDetected,

    artwork_box:
      artworkBox,

    artwork_area:
      artworkArea,

    semantic:
      result
  };
}

async function auditForbiddenEnvironment({
  generatedBuffer,
  artworkBox
}) {
  if (!artworkBox) {
    return {
      passed:
        false,

      forbidden_detected:
        true,

      semantic: {
        confidence:
          0,

        reason:
          'Artwork box unavailable; environment audit fails closed.'
      }
    };
  }

  let environmentOnly;

  try {
    environmentOnly =
      await maskNormalizedBox(
        generatedBuffer,
        artworkBox,
        {
          maxSize:
            1300,

          quality:
            92
        }
      );
  } catch (
    error
  ) {
    return {
      passed:
        false,

      forbidden_detected:
        true,

      semantic: {
        confidence:
          0,

        reason:
          `Environment mask failed: ${error.message}`
      }
    };
  }

  const schema = {
    type:
      'object',

    additionalProperties:
      false,

    required: [
      'potted_plant_or_planter',
      'loose_indoor_plant_or_tree',
      'vase_urn_or_decorative_vessel',
      'decorative_branches_or_flowers',
      'books_or_magazines',
      'console_sideboard_or_credenza',
      'styled_shelving_or_shelf_decor',
      'tabletop_or_surface_decor',
      'decor_cluster',
      'extra_wall_art',
      'confidence',
      'reason'
    ],

    properties: {
      potted_plant_or_planter: {
        type:
          'boolean'
      },

      loose_indoor_plant_or_tree: {
        type:
          'boolean'
      },

      vase_urn_or_decorative_vessel: {
        type:
          'boolean'
      },

      decorative_branches_or_flowers: {
        type:
          'boolean'
      },

      books_or_magazines: {
        type:
          'boolean'
      },

      console_sideboard_or_credenza: {
        type:
          'boolean'
      },

      styled_shelving_or_shelf_decor: {
        type:
          'boolean'
      },

      tabletop_or_surface_decor: {
        type:
          'boolean'
      },

      decor_cluster: {
        type:
          'boolean'
      },

      extra_wall_art: {
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

  let result;

  try {
    const response =
      await openai()
        .responses
        .create({
          model:
            COMPLIANCE_MODEL,

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
                    `You are the final forbidden-environment audit for an Etsy wall-art thumbnail.

The product artwork area has already been covered by a flat gray rectangle. Inspect ONLY the visible room/environment around that gray rectangle.

Mark the corresponding boolean TRUE if ANY of these appear anywhere in the remaining environment:
- potted plant, planter, flower pot, indoor tree, loose decorative plant
- vase, urn, decorative vessel, flower/branch arrangement
- books, book stack, coffee-table book, magazine
- console, credenza, sideboard or cabinet used beneath/near the artwork
- styled shelf or shelf decor
- tabletop, bench, plinth or surface decor such as bowls, trays, candles, sculptures, books, vases or accessory clusters
- extra wall art

Normal architectural structure, an empty bench, a sofa, bed, chair, bare pedestal/plinth, window, doorway or stairs are allowed when they contain NO banned decor.

Do not infer what was hidden by the gray rectangle. Judge only visible environment. Be conservative: if an object is reasonably identifiable as a banned category, mark it true.`
                },

                {
                  type:
                    'input_image',

                  image_url:
                    `data:image/jpeg;base64,${environmentOnly.toString('base64')}`,

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
                'vaelons_forbidden_environment_audit_v1',

              strict:
                true,

              schema
            }
          }
        });

    result =
      JSON.parse(
        response.output_text ||
        '{}'
      );

  } catch (
    error
  ) {
    return {
      passed:
        false,

      forbidden_detected:
        true,

      semantic: {
        confidence:
          0,

        reason:
          `Forbidden environment audit failed: ${error.message}`
      }
    };
  }

  const forbiddenDetected =
    result.potted_plant_or_planter ===
      true ||
    result.loose_indoor_plant_or_tree ===
      true ||
    result.vase_urn_or_decorative_vessel ===
      true ||
    result.decorative_branches_or_flowers ===
      true ||
    result.books_or_magazines ===
      true ||
    result.console_sideboard_or_credenza ===
      true ||
    result.styled_shelving_or_shelf_decor ===
      true ||
    result.tabletop_or_surface_decor ===
      true ||
    result.decor_cluster ===
      true ||
    result.extra_wall_art ===
      true;

  return {
    passed:
      forbiddenDetected ===
        false &&
      Number(
        result.confidence ||
        0
      ) >=
        0.9,

    forbidden_detected:
      forbiddenDetected,

    semantic:
      result
  };
}


async function artworkIdentityCheck({
  title,
  referenceBuffers,
  candidateArtworkBuffer,
  artworkContext
}) {
  const references =
    await Promise.all(
      referenceBuffers.map(
        (buffer) =>
          normalizeJpeg(
            buffer,
            1200,
            94
          )
      )
    );

  const candidate =
    await normalizeJpeg(
      candidateArtworkBuffer,
      1200,
      94
    );

  const schema = {
    type:
      'object',

    additionalProperties:
      false,

    required: [
      'pass',
      'same_artwork_identity',
      'subject_preserved',
      'composition_preserved',
      'important_elements_preserved',
      'color_identity_preserved',
      'text_signature_preserved',
      'invented_artwork_content',
      'removed_artwork_content',
      'crop_or_warp_problem',
      'candidate_artwork_readable',
      'confidence',
      'reason'
    ],

    properties: {
      pass: {
        type:
          'boolean'
      },

      same_artwork_identity: {
        type:
          'boolean'
      },

      subject_preserved: {
        type:
          'boolean'
      },

      composition_preserved: {
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

      text_signature_preserved: {
        type:
          'boolean'
      },

      invented_artwork_content: {
        type:
          'boolean'
      },

      removed_artwork_content: {
        type:
          'boolean'
      },

      crop_or_warp_problem: {
        type:
          'boolean'
      },

      candidate_artwork_readable: {
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
        `You are the artwork-identity gate for a premium Etsy thumbnail.

Listing title:
${title || ''}

Known artwork context:
${JSON.stringify({
  subject:
    artworkContext?.artwork_subject,
  style:
    artworkContext?.artwork_style,
  palette:
    artworkContext?.palette,
  must_preserve:
    artworkContext?.must_preserve
})}

The first images are isolated PRODUCT-TRUTH artwork crops.
The final image is an isolated crop of the artwork as it appears in the generated hero.

Compare ARTWORK TO ARTWORK only.
PASS only when it is unmistakably the same artwork/product:
- same subject and visual identity
- same important composition and elements
- same orientation/proportions without harmful crop, stretch or warp
- faithful color identity; do not reward recoloring
- no invented or removed artwork content
- artwork text/signature that belongs to the product is preserved rather than invented or replaced
- if the PRODUCT-TRUTH artwork contains no text/signature at all, set text_signature_preserved=true; do not invent a missing-text problem
- candidate artwork is readable enough for a mobile Etsy thumbnail

Be strict. Similar subject matter is NOT enough.`
    },

    {
      type:
        'input_text',

      text:
        'PRODUCT-TRUTH ARTWORK CROPS:'
    },

    ...references.map(
      (reference) => ({
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
        'input_text',

      text:
        'CANDIDATE ARTWORK CROP:'
    },

    {
      type:
        'input_image',

      image_url:
        `data:image/jpeg;base64,${candidate.toString('base64')}`,

      detail:
        'high'
    }
  ];

  let result;

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
                'vaelons_artwork_identity_v2',

              strict:
                true,

              schema
            }
          }
        });

    result =
      JSON.parse(
        response.output_text ||
        '{}'
      );

  } catch (
    error
  ) {
    result = {
      pass:
        false,

      same_artwork_identity:
        false,

      subject_preserved:
        false,

      composition_preserved:
        false,

      important_elements_preserved:
        false,

      color_identity_preserved:
        false,

      text_signature_preserved:
        false,

      invented_artwork_content:
        true,

      removed_artwork_content:
        true,

      crop_or_warp_problem:
        true,

      candidate_artwork_readable:
        false,

      confidence:
        0,

      reason:
        `Artwork identity request failed: ${error.message}`
    };
  }

  const passed =
    result.pass ===
      true &&
    result.same_artwork_identity ===
      true &&
    result.subject_preserved ===
      true &&
    result.composition_preserved ===
      true &&
    result.important_elements_preserved ===
      true &&
    result.color_identity_preserved ===
      true &&
    result.text_signature_preserved ===
      true &&
    result.invented_artwork_content ===
      false &&
    result.removed_artwork_content ===
      false &&
    result.crop_or_warp_problem ===
      false &&
    result.candidate_artwork_readable ===
      true &&
    Number(
      result.confidence ||
      0
    ) >=
      0.9;

  return {
    passed,

    semantic:
      result
  };
}

async function qualityCheck({
  title,
  referenceBuffers,
  generatedBuffer,
  scenePlan,
  artworkContext,
  recentGenerated = []
}) {
  const generatedAnalysis =
    await analyzeImage(
      generatedBuffer
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

  const staging =
    await inspectStagingCompliance({
      generatedBuffer,
      scenePlan,
      recentGenerated
    });

  const environmentAudit =
    await auditForbiddenEnvironment({
      generatedBuffer,
      artworkBox:
        staging.artwork_box
    });

  let candidateArtworkBuffer =
    generatedBuffer;

  if (
    staging.artwork_box
  ) {
    try {
      candidateArtworkBuffer =
        await cropNormalizedBox(
          generatedBuffer,
          staging.artwork_box,
          {
            maxSize:
              1600,

            quality:
              96
          }
        );
    } catch (
      error
    ) {
      console.warn(
        'Candidate artwork crop failed:',
        error.message
      );
    }
  }

  const identity =
    await artworkIdentityCheck({
      title,
      referenceBuffers,
      candidateArtworkBuffer,
      artworkContext
    });

  return {
    passed:
      technicalPass &&
      staging.passed &&
      environmentAudit.passed &&
      identity.passed,

    technical_passed:
      technicalPass,

    staging_passed:
      staging.passed,

    environment_audit_passed:
      environmentAudit.passed,

    identity_passed:
      identity.passed,

    generated_analysis:
      generatedAnalysis,

    scene_plan: {
      scene_family:
        scenePlan?.scene_family ||
        null,

      scene_label:
        scenePlan?.scene_label ||
        null,

      decor_signature:
        scenePlan?.decor_signature ||
        null,

      architecture:
        scenePlan?.architecture ||
        null,

      camera:
        scenePlan?.camera ||
        null
    },

    staging,

    environment_audit:
      environmentAudit,

    identity,

    semantic: {
      pass:
        staging.passed &&
        environmentAudit.passed &&
        identity.passed,

      confidence:
        Math.min(
          Number(
            staging
              ?.semantic
              ?.confidence ||
            0
          ),
          Number(
            environmentAudit
              ?.semantic
              ?.confidence ||
            0
          ),
          Number(
            identity
              ?.semantic
              ?.confidence ||
            0
          )
        ),

      reason:
        [
          staging
            ?.semantic
            ?.reason,
          environmentAudit
            ?.semantic
            ?.reason,
          identity
            ?.semantic
            ?.reason
        ]
          .filter(Boolean)
          .join(
            ' | '
          )
    }
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
  reason,
  artworkContext,
  scenePlan
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

    artworkContext:
      artworkContext ||
      null,

    scenePlan:
      scenePlan ||
      null,

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

  await addSceneHistory({
    preview_token:
      token,

    listing_id:
      String(
        listingId
      ),

    scene_family:
      scenePlan
        ?.scene_family ||
      null,

    decor_signature:
      scenePlan
        ?.decor_signature ||
      null,

    observed_architecture:
      qc
        ?.staging
        ?.semantic
        ?.observed_architecture ||
      null,

    layout_signature:
      qc
        ?.staging
        ?.semantic
        ?.layout_signature ||
      scenePlan
        ?.decor_signature ||
      null,

    artwork_subject:
      scenePlan
        ?.artwork_subject ||
      null
  });

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
    await isolateArtworkReferences(
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

  const recentHistory =
    await getRecentSceneHistory();

  const artworkContext =
    await analyzeArtworkContext({
      title:
        exact
          ?.title ||
        '',

      references
    });

  let scenePlan =
    chooseScenePlan({
      listingId,

      title:
        exact
          ?.title ||
        '',

      artworkContext,
      recentHistory
    });

  const recentGenerated =
    await loadRecentGeneratedComparisons({
      listingId
    });

  let generated =
    null;

  let qc =
    null;

  const attemptedScenes =
    [];

  const failedGenerated =
    [];

  for (
    let attempt = 1;
    attempt <=
    MAX_GENERATION_ATTEMPTS;
    attempt +=
      1
  ) {
    attemptedScenes.push(
      scenePlan.scene_family
    );

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

        scenePlan,

        retryNote:
          attempt >
          1
            ? qc
                ?.semantic
                ?.reason ||
              'Previous attempt failed. Change architecture and camera visibly, preserve exact artwork identity, and remove every forbidden staging object.'
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
            (ref) =>
              ref.buffer
          ),

        generatedBuffer:
          generated,

        scenePlan,

        artworkContext,

        recentGenerated: [
          ...failedGenerated,
          ...recentGenerated
        ]
      });

    if (
      qc.passed
    ) {
      break;
    }

    failedGenerated.unshift({
      listing_id:
        String(
          listingId
        ),

      scene_family:
        scenePlan
          ?.scene_family ||
        null,

      decor_signature:
        scenePlan
          ?.decor_signature ||
        null,

      observed_architecture:
        qc
          ?.staging
          ?.semantic
          ?.observed_architecture ||
        null,

      layout_signature:
        qc
          ?.staging
          ?.semantic
          ?.layout_signature ||
        null,

      buffer:
        generated
    });

    if (
      failedGenerated.length >
      2
    ) {
      failedGenerated.length =
        2;
    }

    if (
      attempt <
      MAX_GENERATION_ATTEMPTS
    ) {
      scenePlan =
        chooseScenePlan({
          listingId,

          title:
            exact
              ?.title ||
            '',

          artworkContext,

          recentHistory,

          extraExcluded:
            attemptedScenes
        });
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

      referenceIsolation:
        references.map(
          (ref) =>
            ref.isolation ||
            null
        ),

      artworkContext,

      scenePlan,

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

      reference_isolation:
        references.map(
          (ref) =>
            ref.isolation ||
            null
        ),

      artwork_context:
        artworkContext,

      scene_plan:
        scenePlan,

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

      reason,

      artworkContext,

      scenePlan
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

      referenceIsolation:
        references.map(
          (ref) =>
            ref.isolation ||
            null
        ),

      artworkContext,

      scenePlan,

      qc
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
      'preview_ready',

    reason,

    previous_rank1_score:
      rank1Score,

    source_image_id:
      sourceImageId,

    reference_image_ids:
      referenceImageIds,

    reference_isolation:
      references.map(
        (ref) =>
          ref.isolation ||
          null
      ),

    preview_token:
      preview.token,

    preview_url:
      preview.previewUrl,

    qc,

    artwork_context:
      artworkContext,

    scene_plan:
      scenePlan,

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
        '3.2.0',

      worker_mode:
        WORKER_MODE,

      image_model:
        IMAGE_MODEL,

      qa_model:
        QA_MODEL,

      compliance_model:
        COMPLIANCE_MODEL,

      artwork_reference_isolation:
        true,

      hard_staging_gate:
        true,

      cropped_artwork_identity_qa:
        true,

      masked_environment_audit:
        true,

      max_generation_attempts:
        MAX_GENERATION_ATTEMPTS,

      openai_key_source:
        'VAELONS_OPENAI_API_KEY',

      safe_replace_order:
        'isolate artwork -> artwork-aware scene plan -> generate -> hard staging gate -> masked environment audit -> cropped artwork identity QA -> preview -> ONAYLIYORUM -> upload -> verify rank1 -> delete old -> verify',

      approval_required:
        'ONAYLIYORUM',

      artwork_aware_scene_planner:
        true,

      anti_repeat_memory:
        true
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
          '3.2.0',

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

        approval_required:
          'ONAYLIYORUM',

        anti_repeat_memory:
          true,

        artwork_reference_isolation:
          true,

        hard_staging_gate:
          true,

        cropped_artwork_identity_qa:
          true,

        max_generation_attempts:
          MAX_GENERATION_ATTEMPTS,

        recent_scene_count:
          (await getRecentSceneHistory()).length,

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

      const data =
        await getListingImages(
          listingId
        );

      const ordered =
        [
          ...(data?.results || [])
        ].sort(
          (a, b) =>
            Number(
              a?.rank ??
              9999
            ) -
            Number(
              b?.rank ??
              9999
            )
        );

      const rank1 =
        ordered.find(
          (image) =>
            Number(
              image?.rank
            ) ===
            1
        ) ||
        ordered[0] ||
        null;

      res.json({
        listing_id:
          Number(
            listingId
          ),

        count:
          ordered.length,

        rank1_image_id:
          rank1
            ? getImageId(rank1)
            : null,

        rank1_image_url:
          rank1
            ? getImageUrl(rank1)
            : null,

        images:
          ordered.map(
            (image) => ({
              image_id:
                getImageId(image),

              rank:
                Number(
                  image?.rank ??
                  0
                ),

              image_url:
                getImageUrl(image)
            })
          ),

        // Preserve raw Etsy-compatible results for existing callers.
        results:
          ordered,

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
  '/api/listings/:listingId/images',
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

      const refs =
        req.body
          ?.openaiFileIdRefs;

      if (
        !Array.isArray(refs) ||
        refs.length !==
        1
      ) {
        return res
          .status(400)
          .json({
            error:
              'Exactly one image file is required',

            etsy_modified:
              false
          });
      }

      const fileRef =
        refs[0];

      if (
        !fileRef ||
        typeof fileRef !==
          'object' ||
        !fileRef.download_link
      ) {
        return res
          .status(400)
          .json({
            error:
              'Valid file reference with download_link is required',

            etsy_modified:
              false
          });
      }

      const before =
        await getListingImages(
          listingId
        );

      if (
        (before?.results || [])
          .length >=
        20
      ) {
        return res
          .status(409)
          .json({
            error:
              'Listing already has 20 images',

            etsy_modified:
              false
          });
      }

      const imageBuffer =
        await downloadImage(
          fileRef.download_link
        );

      const requestedRank =
        Number(
          req.body
            ?.rank
        );

      const rank =
        Number.isInteger(
          requestedRank
        ) &&
        requestedRank >
          0
          ? requestedRank
          : (before?.results || [])
              .length +
            1;

      const result =
        await uploadListingImage({
          shopId:
            await getShopId(),

          listingId,

          imageBuffer,

          filename:
            fileRef.name ||
            `vaelons-${listingId}-image.jpg`,

          contentType:
            fileRef.mime_type ||
            'image/jpeg',

          rank,

          overwrite:
            false,

          altText:
            String(
              req.body
                ?.alt_text ||
              ''
            ).slice(
              0,
              500
            )
        });

      etsyModified =
        true;

      const verified =
        await getListingImages(
          listingId
        );

      res.json({
        success:
          true,

        listing_id:
          Number(
            listingId
          ),

        upload_result:
          result,

        image_count:
          (verified?.results || [])
            .length,

        images:
          verified?.results ||
          [],

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

app.post(
  '/api/listings/:listingId/images/:imageId/rank',
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

      const imageId =
        asListingId(
          req.params
            .imageId
        );

      const approval =
        String(
          req.body
            ?.approval ||
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

      const rank =
        Number(
          req.body
            ?.rank
        );

      if (
        !Number.isInteger(rank) ||
        rank <
          1
      ) {
        return res
          .status(400)
          .json({
            error:
              'rank must be a positive integer',

            etsy_modified:
              false
          });
      }

      const result =
        await setListingImageRank({
          shopId:
            await getShopId(),

          listingId,

          listingImageId:
            imageId,

          rank
        });

      etsyModified =
        true;

      res.json({
        ...result,

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

app.delete(
  '/api/listings/:listingId/images/:imageId',
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

      const imageId =
        asListingId(
          req.params
            .imageId
        );

      const approval =
        String(
          req.body
            ?.approval ||
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

      const result =
        await deleteListingImage({
          shopId:
            await getShopId(),

          listingId,

          listingImageId:
            imageId,

          verify:
            true
        });

      etsyModified =
        result?.deleted ===
        true;

      res.json({
        ...result,

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
        `VAELONS AI Thumbnail Worker v3.2.0 listening on :${port}`
      );
    }
  );
}
