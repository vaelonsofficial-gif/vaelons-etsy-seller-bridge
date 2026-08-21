import express from 'express';
import sharp from 'sharp';
import { createHmac, timingSafeEqual } from 'node:crypto';

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

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));


const PREVIEW_TTL_MS = 20 * 60 * 1000;
const CLEANUP_TTL_MS = 24 * 60 * 60 * 1000;
const SCAN_MAX_LIMIT = 10;


/* =========================================================
   BASIC HELPERS
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


function publicBase() {
  return required('PUBLIC_BASE_URL').replace(/\/$/, '');
}


function bridgeAuth(req, res, next) {
  const auth = req.get('authorization') || '';

  if (
    auth !==
    `Bearer ${required('BRIDGE_API_KEY')}`
  ) {
    return res.status(401).json({
      error: 'unauthorized'
    });
  }

  next();
}


function parseCookies(req) {
  const result = {};

  for (
    const part of
    (req.headers.cookie || '').split(';')
  ) {
    const idx = part.indexOf('=');

    if (idx > -1) {
      result[
        part.slice(0, idx).trim()
      ] = decodeURIComponent(
        part.slice(idx + 1).trim()
      );
    }
  }

  return result;
}


async function sid() {
  return String(
    await getShopId()
  );
}


function asListingId(value) {
  const id = String(value || '').trim();

  if (!/^\d+$/.test(id)) {
    const err = new Error(
      'Invalid listingId'
    );

    err.status = 400;
    throw err;
  }

  return id;
}


function asSectionId(value) {
  const id = String(value || '').trim();

  if (!/^\d+$/.test(id)) {
    const err = new Error(
      'Invalid sectionId'
    );

    err.status = 400;
    throw err;
  }

  return id;
}


function clamp(value, min, max) {
  return Math.max(
    min,
    Math.min(max, value)
  );
}


function round1(value) {
  return Math.round(
    Number(value) * 10
  ) / 10;
}


function smoothstep(edge0, edge1, value) {
  const t = clamp(
    (value - edge0) /
    (edge1 - edge0),
    0,
    1
  );

  return (
    t *
    t *
    (3 - 2 * t)
  );
}


function getImageId(image) {
  return (
    image?.listing_image_id ??
    image?.image_id ??
    null
  );
}


function getImageUrl(image) {
  return (
    image?.url_fullxfull ||
    image?.url_570xN ||
    image?.url_300x300 ||
    image?.url_170x135 ||
    image?.url_75x75 ||
    null
  );
}


function extractUploadedImage(uploadResult) {
  if (!uploadResult) {
    return null;
  }

  if (
    Array.isArray(
      uploadResult?.results
    )
  ) {
    return (
      uploadResult.results[0] ||
      null
    );
  }

  return uploadResult;
}


/* =========================================================
   LISTING IMAGE HELPERS
========================================================= */

async function getListingImageSet(listingId) {
  const data =
    await getListingImages(
      listingId
    );

  const images =
    Array.isArray(data?.results)
      ? data.results
      : [];

  if (!images.length) {
    const err = new Error(
      'No listing images found'
    );

    err.status = 404;
    throw err;
  }

  const ordered =
    [...images].sort(
      (a, b) =>
        Number(
          a.rank ?? 9999
        ) -
        Number(
          b.rank ?? 9999
        )
    );

  const rank1 =
    images.find(
      (img) =>
        Number(img.rank) === 1
    ) ||
    ordered[0];

  const rank2 =
    images.find(
      (img) =>
        Number(img.rank) === 2
    ) ||
    ordered[1] ||
    null;

  const rank1Url =
    getImageUrl(rank1);

  if (!rank1Url) {
    const err = new Error(
      'No usable rank 1 image URL found'
    );

    err.status = 404;
    throw err;
  }

  const rank2Url =
    rank2
      ? getImageUrl(rank2)
      : null;

  return {
    images,

    rank1: {
      image: rank1,
      imageId:
        getImageId(rank1),
      imageUrl:
        rank1Url
    },

    rank2:
      rank2 && rank2Url
        ? {
            image: rank2,
            imageId:
              getImageId(rank2),
            imageUrl:
              rank2Url
          }
        : null
  };
}


async function downloadImage(url) {
  const parsed =
    new URL(url);

  if (
    parsed.protocol !== 'https:'
  ) {
    const err = new Error(
      'Image URL must use HTTPS'
    );

    err.status = 400;
    throw err;
  }

  const response =
    await fetch(url);

  if (!response.ok) {
    const err = new Error(
      `Could not download image (${response.status})`
    );

    err.status = 502;
    throw err;
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (
    buffer.length >
    20 * 1024 * 1024
  ) {
    const err = new Error(
      'Image is larger than 20 MB'
    );

    err.status = 413;
    throw err;
  }

  return {
    buffer,

    contentType:
      response.headers.get(
        'content-type'
      ) ||
      'image/jpeg'
  };
}


/* =========================================================
   IMAGE ANALYSIS
========================================================= */

function percentileFromSorted(
  values,
  fraction
) {
  if (!values.length) {
    return 0;
  }

  const index =
    clamp(
      Math.round(
        (values.length - 1) *
        fraction
      ),
      0,
      values.length - 1
    );

  return values[index];
}


async function analyzeImage(buffer) {
  const metadata =
    await sharp(buffer)
      .metadata();

  const {
    data,
    info
  } =
    await sharp(buffer)
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .resize({
        width: 420,
        height: 420,
        fit: 'inside',
        withoutEnlargement: true
      })
      .raw()
      .toBuffer({
        resolveWithObject: true
      });

  const channels =
    info.channels;

  const luminanceValues = [];

  let sumL = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;

  let sumChroma = 0;

  let shadowCount = 0;
  let deepShadowCount = 0;
  let highlightCount = 0;

  let pixelCount = 0;

  for (
    let i = 0;
    i < data.length;
    i += channels
  ) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const luminance =
      Math.round(
        0.2126 * r +
        0.7152 * g +
        0.0722 * b
      );

    const maxRgb =
      Math.max(r, g, b);

    const minRgb =
      Math.min(r, g, b);

    luminanceValues.push(
      luminance
    );

    sumL += luminance;
    sumR += r;
    sumG += g;
    sumB += b;

    sumChroma +=
      maxRgb - minRgb;

    if (luminance < 55) {
      shadowCount += 1;
    }

    if (luminance < 28) {
      deepShadowCount += 1;
    }

    if (luminance > 230) {
      highlightCount += 1;
    }

    pixelCount += 1;
  }

  luminanceValues.sort(
    (a, b) => a - b
  );

  const count =
    pixelCount || 1;

  const brightness =
    Math.round(
      sumL / count
    );

  let varianceSum = 0;

  for (
    const value of
    luminanceValues
  ) {
    const delta =
      value - brightness;

    varianceSum +=
      delta * delta;
  }

  const contrast =
    Math.round(
      Math.sqrt(
        varianceSum / count
      )
    );

  const p10 =
    percentileFromSorted(
      luminanceValues,
      0.10
    );

  const p50 =
    percentileFromSorted(
      luminanceValues,
      0.50
    );

  const p90 =
    percentileFromSorted(
      luminanceValues,
      0.90
    );

  const tonalRange =
    p90 - p10;

  let darknessLabel =
    'good';

  if (brightness < 60) {
    darknessLabel =
      'very_dark';
  } else if (
    brightness < 75
  ) {
    darknessLabel =
      'dark';
  } else if (
    brightness < 90
  ) {
    darknessLabel =
      'slightly_dark';
  }

  return {
    width:
      metadata.width ??
      info.width ??
      null,

    height:
      metadata.height ??
      info.height ??
      null,

    brightness_0_255:
      brightness,

    contrast_stdev:
      contrast,

    darkness_label:
      darknessLabel,

    p10,
    p50,
    p90,

    tonal_range_p10_p90:
      tonalRange,

    shadow_percent:
      round1(
        (
          shadowCount /
          count
        ) *
        100
      ),

    deep_shadow_percent:
      round1(
        (
          deepShadowCount /
          count
        ) *
        100
      ),

    highlight_percent:
      round1(
        (
          highlightCount /
          count
        ) *
        100
      ),

    mean_rgb: {
      r:
        round1(
          sumR / count
        ),

      g:
        round1(
          sumG / count
        ),

      b:
        round1(
          sumB / count
        )
    },

    mean_chroma:
      round1(
        sumChroma / count
      )
  };
}


/* =========================================================
   THUMBNAIL SCORING
========================================================= */

function assessThumbnail(
  analysis
) {
  let score = 100;

  const b =
    analysis.brightness_0_255;

  const shadows =
    analysis.shadow_percent;

  const deep =
    analysis.deep_shadow_percent;

  const highlights =
    analysis.highlight_percent;

  const tonalRange =
    analysis
      .tonal_range_p10_p90;

  if (b < 50) {
    score -= 34;
  } else if (b < 60) {
    score -= 27;
  } else if (b < 70) {
    score -= 19;
  } else if (b < 80) {
    score -= 11;
  } else if (b < 90) {
    score -= 5;
  }

  if (shadows > 60) {
    score -= 24;
  } else if (
    shadows > 50
  ) {
    score -= 17;
  } else if (
    shadows > 40
  ) {
    score -= 10;
  } else if (
    shadows > 32
  ) {
    score -= 5;
  }

  if (deep > 38) {
    score -= 14;
  } else if (
    deep > 28
  ) {
    score -= 9;
  } else if (
    deep > 20
  ) {
    score -= 4;
  }

  if (highlights > 14) {
    score -= 8;
  } else if (
    highlights > 8
  ) {
    score -= 4;
  }

  if (tonalRange < 55) {
    score -= 12;
  } else if (
    tonalRange < 70
  ) {
    score -= 6;
  }

  score =
    clamp(
      Math.round(score),
      0,
      100
    );

  let priority =
    'none';

  let recommendedAction =
    'keep';

  if (score < 45) {
    priority =
      'urgent';

    recommendedAction =
      'prepare_reference_preserving_preview';

  } else if (
    score < 60
  ) {
    priority =
      'high';

    recommendedAction =
      'prepare_reference_preserving_preview';

  } else if (
    score < 75
  ) {
    priority =
      'review';

    recommendedAction =
      'review_before_repair';
  }

  return {
    readability_score_0_100:
      score,

    priority,

    recommended_action:
      recommendedAction,

    auto_publish_allowed:
      false,

    reason:
      recommendedAction ===
      'keep'
        ? 'Thumbnail readability is within the conservative safe range.'
        : 'Thumbnail may be too dark on small screens. A reference-preserving preview and visual approval are required.'
  };
}


/* =========================================================
   V4 REPAIR TARGET
========================================================= */

function normalizeRepairMode(
  value
) {
  const mode =
    String(
      value ||
      'auto'
    )
      .trim()
      .toLowerCase();

  if (
    [
      'auto',
      'gentle',
      'balanced'
    ].includes(mode)
  ) {
    return mode;
  }

  return 'auto';
}


function chooseTargetBrightness(
  beforeBrightness,
  mode
) {
  let target;

  if (
    beforeBrightness < 40
  ) {
    target = 58;

  } else if (
    beforeBrightness < 50
  ) {
    target = 64;

  } else if (
    beforeBrightness < 60
  ) {
    target = 70;

  } else if (
    beforeBrightness < 70
  ) {
    target = 76;

  } else if (
    beforeBrightness < 80
  ) {
    target = 82;

  } else {
    target =
      beforeBrightness;
  }

  if (
    mode === 'gentle'
  ) {
    target -= 6;
  }

  if (
    mode === 'balanced'
  ) {
    target += 5;
  }

  return clamp(
    Math.round(target),
    beforeBrightness,
    88
  );
}


/* =========================================================
   V4 REFERENCE-PRESERVING PIXEL LIFT
========================================================= */

function liftPixelV4(
  r,
  g,
  b,
  strength
) {
  const y =
    (
      0.2126 * r +
      0.7152 * g +
      0.0722 * b
    ) /
    255;

  /*
    Black protection:
    Pixels very close to true black
    should remain dark.
  */
  const blackProtect =
    smoothstep(
      0.018,
      0.085,
      y
    );

  /*
    Highlight protection:
    Above ~70% luminance,
    adjustment fades rapidly.
  */
  const highlightProtect =
    1 -
    smoothstep(
      0.68,
      0.90,
      y
    );

  /*
    Main shadow mask.
    Maximum effect in shadow /
    mid-shadow range.
  */
  const shadowMask =
    Math.pow(
      1 - y,
      2.0
    );

  /*
    Mid-shadow support.
    Helps reveal artwork detail
    without flattening highlights.
  */
  const midMask =
    smoothstep(
      0.08,
      0.24,
      y
    ) *
    (
      1 -
      smoothstep(
        0.50,
        0.72,
        y
      )
    );

  let weight =
    (
      shadowMask *
      0.78
    ) +
    (
      midMask *
      0.36
    );

  weight *=
    blackProtect;

  weight *=
    highlightProtect;

  weight =
    clamp(
      weight,
      0,
      1
    );

  /*
    Add luminance,
    but keep RGB proportions.

    This avoids global grey wash
    from adding the same offset
    to every RGB channel.
  */
  const lift =
    strength *
    weight *
    (
      0.42 -
      0.18 * y
    );

  const newY =
    clamp(
      y + lift,
      0,
      1
    );

  let scale =
    y > 0.001
      ? newY / y
      : 1;

  /*
    Prevent dark pixels
    from exploding unnaturally.
  */
  scale =
    clamp(
      scale,
      1,
      1.90
    );

  let nr =
    r * scale;

  let ng =
    g * scale;

  let nb =
    b * scale;

  /*
    Tiny neutral guard only.
    This is NOT desaturation.
    It prevents exaggerated warm cast.
  */
  const avg =
    (
      nr +
      ng +
      nb
    ) /
    3;

  nr =
    nr * 0.992 +
    avg * 0.008;

  ng =
    ng * 0.995 +
    avg * 0.005;

  nb =
    nb * 0.993 +
    avg * 0.007;

  return [
    clamp(
      Math.round(nr),
      0,
      255
    ),

    clamp(
      Math.round(ng),
      0,
      255
    ),

    clamp(
      Math.round(nb),
      0,
      255
    )
  ];
}


async function renderLiftV4(
  sourceBuffer,
  strength
) {
  const {
    data,
    info
  } =
    await sharp(
      sourceBuffer
    )
      .rotate()
      .removeAlpha()
      .toColourspace(
        'srgb'
      )
      .raw()
      .toBuffer({
        resolveWithObject:
          true
      });

  if (
    info.channels < 3
  ) {
    const err =
      new Error(
        'Unsupported image channel layout'
      );

    err.status = 422;
    throw err;
  }

  const output =
    Buffer.allocUnsafe(
      data.length
    );

  const channels =
    info.channels;

  for (
    let i = 0;
    i < data.length;
    i += channels
  ) {
    const r =
      data[i];

    const g =
      data[i + 1];

    const b =
      data[i + 2];

    const [
      nr,
      ng,
      nb
    ] =
      liftPixelV4(
        r,
        g,
        b,
        strength
      );

    output[i] =
      nr;

    output[i + 1] =
      ng;

    output[i + 2] =
      nb;

    for (
      let c = 3;
      c < channels;
      c += 1
    ) {
      output[i + c] =
        data[i + c];
    }
  }

  return sharp(
    output,
    {
      raw: {
        width:
          info.width,

        height:
          info.height,

        channels:
          info.channels
      }
    }
  )
    .jpeg({
      quality: 96,
      chromaSubsampling:
        '4:4:4',
      mozjpeg: true
    })
    .toBuffer();
}


/* =========================================================
   V4 AUTOMATIC STRENGTH SEARCH

   Finds the weakest strength that gets
   close to the conservative target.
========================================================= */

async function findV4Repair(
  sourceBuffer,
  before,
  mode
) {
  const target =
    chooseTargetBrightness(
      before.brightness_0_255,
      mode
    );

  if (
    target <=
    before.brightness_0_255
  ) {
    return {
      target,
      strength: 0,
      repaired:
        sourceBuffer,
      after:
        before
    };
  }

  let low = 0.08;
  let high = 0.95;

  let best = null;

  for (
    let attempt = 0;
    attempt < 7;
    attempt += 1
  ) {
    const strength =
      (
        low +
        high
      ) /
      2;

    const candidate =
      await renderLiftV4(
        sourceBuffer,
        strength
      );

    const analysis =
      await analyzeImage(
        candidate
      );

    const distance =
      Math.abs(
        target -
        analysis
          .brightness_0_255
      );

    if (
      !best ||
      distance <
      best.distance
    ) {
      best = {
        strength,
        repaired:
          candidate,
        after:
          analysis,
        distance
      };
    }

    if (
      analysis
        .brightness_0_255 <
      target
    ) {
      low =
        strength;
    } else {
      high =
        strength;
    }
  }

  return {
    target,

    strength:
      round1(
        best.strength
      ),

    repaired:
      best.repaired,

    after:
      best.after
  };
}


/* =========================================================
   COLOR / CONSISTENCY
========================================================= */

function rgbDistance(a, b) {
  if (!a || !b) {
    return null;
  }

  return Math.sqrt(
    Math.pow(
      Number(a.r) -
      Number(b.r),
      2
    ) +
    Math.pow(
      Number(a.g) -
      Number(b.g),
      2
    ) +
    Math.pow(
      Number(a.b) -
      Number(b.b),
      2
    )
  );
}


function validateRepairResult(
  before,
  after
) {
  const brightnessGain =
    after.brightness_0_255 -
    before.brightness_0_255;

  const contrastRatio =
    before.contrast_stdev > 0
      ? (
          after.contrast_stdev /
          before.contrast_stdev
        )
      : 1;

  const highlightIncrease =
    after.highlight_percent -
    before.highlight_percent;

  const chromaDelta =
    Math.abs(
      after.mean_chroma -
      before.mean_chroma
    );

  const meanRgbDelta =
    rgbDistance(
      before.mean_rgb,
      after.mean_rgb
    ) ?? 0;

  const warnings = [];

  if (
    brightnessGain < 4 &&
    before.brightness_0_255 < 70
  ) {
    warnings.push(
      'repair_too_weak'
    );
  }

  /*
    We deliberately do not want
    the old 31 -> 110 behaviour.
  */
  if (
    brightnessGain > 36
  ) {
    warnings.push(
      'brightness_increase_too_large'
    );
  }

  if (
    contrastRatio < 0.90
  ) {
    warnings.push(
      'contrast_loss_detected'
    );
  }

  if (
    contrastRatio > 1.28
  ) {
    warnings.push(
      'contrast_increase_too_large'
    );
  }

  if (
    highlightIncrease > 4
  ) {
    warnings.push(
      'highlight_clipping_risk'
    );
  }

  if (
    chromaDelta > 14
  ) {
    warnings.push(
      'color_intensity_shift_detected'
    );
  }

  if (
    meanRgbDelta > 32
  ) {
    warnings.push(
      'color_grade_shift_detected'
    );
  }

  const hardWarnings =
    warnings.filter(
      (warning) =>
        warning !==
        'repair_too_weak'
    );

  return {
    safe_for_visual_review:
      hardWarnings.length ===
      0,

    brightness_gain:
      brightnessGain,

    contrast_ratio:
      round1(
        contrastRatio
      ),

    highlight_increase_percent:
      round1(
        highlightIncrease
      ),

    chroma_delta:
      round1(
        chromaDelta
      ),

    mean_rgb_delta:
      round1(
        meanRgbDelta
      ),

    warnings
  };
}


function assessGalleryConsistency(
  source,
  preview,
  rank2Analysis
) {
  const sourceToPreviewRgb =
    rgbDistance(
      source.mean_rgb,
      preview.mean_rgb
    ) ?? 0;

  const chromaDelta =
    Math.abs(
      preview.mean_chroma -
      source.mean_chroma
    );

  const contrastRatio =
    source.contrast_stdev > 0
      ? (
          preview.contrast_stdev /
          source.contrast_stdev
        )
      : 1;

  const warnings = [];

  /*
    Source rank-1 is the hard reference.
    Because image 2 may use a different
    mockup/crop, image 2 is only a soft
    gallery reference.
  */
  if (
    sourceToPreviewRgb > 32
  ) {
    warnings.push(
      'preview_color_drift'
    );
  }

  if (
    chromaDelta > 14
  ) {
    warnings.push(
      'preview_chroma_drift'
    );
  }

  if (
    contrastRatio < 0.90
  ) {
    warnings.push(
      'preview_contrast_loss'
    );
  }

  if (
    contrastRatio > 1.28
  ) {
    warnings.push(
      'preview_contrast_increase'
    );
  }

  let rank2Reference =
    null;

  if (rank2Analysis) {
    const sourceToRank2Rgb =
      rgbDistance(
        source.mean_rgb,
        rank2Analysis.mean_rgb
      ) ?? 0;

    const previewToRank2Rgb =
      rgbDistance(
        preview.mean_rgb,
        rank2Analysis.mean_rgb
      ) ?? 0;

    const moveAway =
      previewToRank2Rgb -
      sourceToRank2Rgb;

    rank2Reference = {
      source_to_rank2_rgb_distance:
        round1(
          sourceToRank2Rgb
        ),

      preview_to_rank2_rgb_distance:
        round1(
          previewToRank2Rgb
        ),

      absolute_move_away:
        round1(
          moveAway
        )
    };

    /*
      Soft warning only.
      Different mockups can naturally
      have different global averages.
    */
    if (
      moveAway > 45 &&
      sourceToPreviewRgb > 20
    ) {
      warnings.push(
        'preview_moves_away_from_gallery_reference'
      );
    }
  }

  const hardWarnings =
    warnings.filter(
      (warning) =>
        warning !==
        'preview_moves_away_from_gallery_reference'
    );

  return {
    passed:
      hardWarnings.length ===
      0,

    hard_block_upload:
      hardWarnings.length >
      0,

    source_to_preview_rgb_distance:
      round1(
        sourceToPreviewRgb
      ),

    source_to_preview_chroma_delta:
      round1(
        chromaDelta
      ),

    source_to_preview_contrast_ratio:
      round1(
        contrastRatio
      ),

    rank2_reference_available:
      Boolean(
        rank2Analysis
      ),

    rank2_reference:
      rank2Reference,

    warnings,

    note:
      rank2Analysis
        ? 'Image 2 is used as a soft gallery reference. The original rank 1 image remains the hard identity reference.'
        : 'Image 2 was unavailable. Consistency is checked against original rank 1 only.'
  };
}


/* =========================================================
   SIGNED TOKENS
========================================================= */

function signToken(payload) {
  const encoded =
    Buffer
      .from(
        JSON.stringify(
          payload
        )
      )
      .toString(
        'base64url'
      );

  const signature =
    createHmac(
      'sha256',
      required(
        'BRIDGE_API_KEY'
      )
    )
      .update(encoded)
      .digest(
        'base64url'
      );

  return (
    `${encoded}.${signature}`
  );
}


function verifyToken(
  token,
  expectedType = null
) {
  const [
    encoded,
    signature
  ] =
    String(
      token || ''
    ).split('.');

  if (
    !encoded ||
    !signature
  ) {
    const err =
      new Error(
        'Invalid signed token'
      );

    err.status = 400;
    throw err;
  }

  const expected =
    createHmac(
      'sha256',
      required(
        'BRIDGE_API_KEY'
      )
    )
      .update(encoded)
      .digest(
        'base64url'
      );

  const a =
    Buffer.from(
      signature
    );

  const b =
    Buffer.from(
      expected
    );

  if (
    a.length !==
      b.length ||
    !timingSafeEqual(
      a,
      b
    )
  ) {
    const err =
      new Error(
        'Invalid signed token signature'
      );

    err.status = 400;
    throw err;
  }

  let payload;

  try {
    payload =
      JSON.parse(
        Buffer
          .from(
            encoded,
            'base64url'
          )
          .toString(
            'utf8'
          )
      );

  } catch {
    const err =
      new Error(
        'Invalid signed token payload'
      );

    err.status = 400;
    throw err;
  }

  if (
    !payload?.exp ||
    Date.now() >
      payload.exp
  ) {
    const err =
      new Error(
        'Signed token expired'
      );

    err.status = 410;
    throw err;
  }

  if (
    expectedType &&
    payload.type !==
      expectedType
  ) {
    const err =
      new Error(
        'Signed token is for a different action'
      );

    err.status = 409;
    throw err;
  }

  return payload;
}


/* =========================================================
   BUILD V4 PREVIEW
========================================================= */

async function buildRepairPreview(
  listingId,
  mode = 'auto'
) {
  const listing =
    await etsyRequest(
      `/listings/${listingId}`
    );

  const imageSet =
    await getListingImageSet(
      listingId
    );

  const {
    buffer:
      sourceBuffer
  } =
    await downloadImage(
      imageSet.rank1.imageUrl
    );

  const before =
    await analyzeImage(
      sourceBuffer
    );

  const assessment =
    assessThumbnail(
      before
    );

  let rank2Analysis =
    null;

  if (
    imageSet.rank2?.imageUrl
  ) {
    try {
      const {
        buffer:
          rank2Buffer
      } =
        await downloadImage(
          imageSet.rank2.imageUrl
        );

      rank2Analysis =
        await analyzeImage(
          rank2Buffer
        );

    } catch (err) {
      console.warn(
        'Image 2 reference could not be analyzed:',
        err.message
      );
    }
  }

  const repair =
    await findV4Repair(
      sourceBuffer,
      before,
      mode
    );

  const validation =
    validateRepairResult(
      before,
      repair.after
    );

  const galleryConsistency =
    assessGalleryConsistency(
      before,
      repair.after,
      rank2Analysis
    );

  const token =
    signToken({
      type:
        'thumbnail_preview_v4',

      listingId,

      sourceImageId:
        String(
          imageSet.rank1.imageId
        ),

      rank2ImageId:
        imageSet.rank2?.imageId
          ? String(
              imageSet.rank2.imageId
            )
          : null,

      method:
        'reference_preserving_shadow_lift_v4',

      strength:
        repair.strength,

      target:
        repair.target,

      mode,

      exp:
        Date.now() +
        PREVIEW_TTL_MS
    });

  return {
    listing,
    imageSet,

    sourceBuffer,

    before,

    after:
      repair.after,

    repaired:
      repair.repaired,

    assessment,

    rank2Analysis,

    strength:
      repair.strength,

    target:
      repair.target,

    mode,

    validation,

    galleryConsistency,

    token
  };
}


/* =========================================================
   WORKER HELPERS
========================================================= */

async function mapLimit(
  items,
  concurrency,
  mapper
) {
  const results =
    new Array(
      items.length
    );

  let cursor = 0;

  async function worker() {
    while (true) {
      const index =
        cursor;

      cursor += 1;

      if (
        index >=
        items.length
      ) {
        return;
      }

      results[index] =
        await mapper(
          items[index],
          index
        );
    }
  }

  await Promise.all(
    Array.from(
      {
        length:
          Math.min(
            concurrency,
            items.length
          )
      },
      () => worker()
    )
  );

  return results;
}


function listingAgeDays(
  listing
) {
  const ts =
    listing
      ?.original_creation_timestamp ??
    listing
      ?.creation_timestamp ??
    listing
      ?.created_timestamp ??
    null;

  if (!ts) {
    return null;
  }

  const age =
    Math.floor(
      (
        Date.now() /
        1000 -
        Number(ts)
      ) /
      86400
    );

  return Number.isFinite(age)
    ? Math.max(
        0,
        age
      )
    : null;
}


function performanceSignal(
  listing
) {
  const ageDays =
    listingAgeDays(
      listing
    );

  const favorites =
    Number(
      listing?.num_favorers ??
      0
    );

  if (
    ageDays === null
  ) {
    return {
      age_days: null,
      num_favorers:
        favorites,
      signal:
        'insufficient_data'
    };
  }

  let signal =
    'insufficient_data';

  if (
    ageDays >= 90 &&
    favorites === 0
  ) {
    signal =
      'weak_favorite_signal';

  } else if (
    ageDays >= 60 &&
    favorites <= 1
  ) {
    signal =
      'low_favorite_signal';

  } else if (
    favorites >= 5
  ) {
    signal =
      'established_favorite_signal';
  }

  return {
    age_days:
      ageDays,

    num_favorers:
      favorites,

    signal
  };
}


function compactImageList(
  data
) {
  return (
    data?.results ||
    []
  ).map(
    (img) => ({
      image_id:
        getImageId(img),

      rank:
        img.rank ??
        null,

      image_url:
        getImageUrl(img)
    })
  );
}


/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/health',
  (_req, res) => {
    res.json({
      ok: true,

      service:
        'vaelons-etsy-seller-bridge',

      thumbnail_engine:
        'reference_preserving_shadow_lift_v4'
    });
  }
);


/* =========================================================
   ETSY OAUTH
========================================================= */

app.get(
  '/oauth/etsy/start',
  (req, res) => {
    if (
      req.query.setup_secret !==
      required(
        'SETUP_SECRET'
      )
    ) {
      return res
        .status(401)
        .send(
          'Invalid setup secret.'
        );
    }

    const state =
      randomBase64Url(24);

    const verifier =
      randomBase64Url(48);

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
        httpOnly: true,
        secure: true,
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
        req.query.error
      ) {
        return res
          .status(400)
          .send(
            `Etsy authorization failed: ${
              req.query
                .error_description ||
              req.query.error
            }`
          );
      }

      const cookie =
        parseCookies(req)
          .etsy_oauth;

      if (!cookie) {
        return res
          .status(400)
          .send(
            'OAuth session expired. Start again.'
          );
      }

      const flow =
        openJson(cookie);

      if (
        !req.query.state ||
        req.query.state !==
          flow.state ||
        Date.now() -
          flow.ts >
          10 *
          60 *
          1000
      ) {
        return res
          .status(400)
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
              req.query.code ||
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
          .status(400)
          .send(
            `Token exchange failed: ${JSON.stringify(token)}`
          );
      }

      await setInitialToken(
        token
      );

      const shopId =
        await getShopId();

      await etsyRequest(
        `/shops/${shopId}/listings`,
        {
          params: {
            limit: 1,
            state:
              'active'
          }
        }
      );

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
        .type('html')
        .send(`
<!doctype html>
<meta charset="utf-8">

<title>
VAELONS Etsy Connected
</title>

<style>
body {
  font-family: system-ui;
  max-width: 800px;
  margin: 60px auto;
  padding: 0 20px;
  line-height: 1.5;
}

textarea {
  width: 100%;
  height: 150px;
  word-break: break-all;
}
</style>

<h2>
VAELONS Etsy Seller bağlantısı doğrulandı.
</h2>

<p>
Aşağıdaki şifreli değeri Vercel Environment Variables bölümüne
<b>ETSY_TOKEN_CAPSULE</b>
adıyla ekleyin.
</p>

<textarea
  readonly
  onclick="this.select()"
>${encryptedCapsule}</textarea>

<p>
Production + Preview seçin, kaydedin ve redeploy yapın.
Bu değeri gizli tutun.
</p>
        `);

    } catch (err) {
      console.error(err);

      res
        .status(
          err.status ||
          500
        )
        .json({
          error:
            err.message,

          details:
            err.details ||
            null
        });
    }
  }
);


/* =========================================================
   PUBLIC PREVIEW IMAGE
========================================================= */

app.get(
  '/preview/thumbnail-repair/:token',
  async (
    req,
    res
  ) => {
    try {
      const payload =
        verifyToken(
          req.params.token,
          'thumbnail_preview_v4'
        );

      const listingId =
        asListingId(
          payload.listingId
        );

      const imageSet =
        await getListingImageSet(
          listingId
        );

      if (
        String(
          imageSet.rank1.imageId
        ) !==
        String(
          payload.sourceImageId
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Current rank 1 image changed after preview was created'
          });
      }

      const {
        buffer:
          sourceBuffer
      } =
        await downloadImage(
          imageSet.rank1.imageUrl
        );

      const repaired =
        Number(
          payload.strength
        ) > 0
          ? await renderLiftV4(
              sourceBuffer,
              Number(
                payload.strength
              )
            )
          : sourceBuffer;

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.setHeader(
        'content-disposition',
        'inline; filename="thumbnail-reference-preserving-v4.jpg"'
      );

      res.setHeader(
        'cache-control',
        'private, max-age=300'
      );

      res.send(
        repaired
      );

    } catch (err) {
      console.error(err);

      res
        .status(
          err.status ||
          400
        )
        .json({
          error:
            err.message
        });
    }
  }
);


/* =========================================================
   PUBLIC 3-WAY COMPARE
========================================================= */

app.get(
  '/preview/thumbnail-repair/:token/compare',
  async (
    req,
    res
  ) => {
    try {
      const payload =
        verifyToken(
          req.params.token,
          'thumbnail_preview_v4'
        );

      const listingId =
        asListingId(
          payload.listingId
        );

      const listing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const imageSet =
        await getListingImageSet(
          listingId
        );

      if (
        String(
          imageSet.rank1.imageId
        ) !==
        String(
          payload.sourceImageId
        )
      ) {
        return res
          .status(409)
          .send(
            'Current rank 1 image changed after preview was created.'
          );
      }

      const token =
        encodeURIComponent(
          req.params.token
        );

      const beforeUrl =
        imageSet.rank1.imageUrl;

      const afterUrl =
        `${publicBase()}/preview/thumbnail-repair/${token}`;

      const rank2Url =
        imageSet.rank2?.imageUrl ||
        null;

      const esc =
        (value) =>
          String(
            value ??
            ''
          )
            .replaceAll(
              '&',
              '&amp;'
            )
            .replaceAll(
              '<',
              '&lt;'
            )
            .replaceAll(
              '>',
              '&gt;'
            )
            .replaceAll(
              '"',
              '&quot;'
            );

      const rank2Card =
        rank2Url
          ? `
<div class="card">
  <div class="label">
    IMAGE 2 — müşteri tutarlılık referansı
  </div>

  <img
    src="${esc(rank2Url)}"
    alt="Image 2 reference"
  >
</div>
`
          : '';

      res
        .type('html')
        .send(`
<!doctype html>

<html lang="tr">

<head>

<meta charset="utf-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1"
>

<title>
VAELONS Thumbnail Compare
</title>

<style>
body {
  font-family:
    system-ui,
    -apple-system,
    sans-serif;

  margin: 0;
  background: #111;
  color: #f5f5f5;
}

main {
  max-width: 1500px;
  margin: 0 auto;
  padding: 24px;
}

h1 {
  font-size: 20px;
  margin: 0 0 8px;
}

p {
  color: #bbb;
  margin: 0 0 20px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(
      3,
      minmax(0, 1fr)
    );
  gap: 18px;
}

.card {
  background: #1b1b1b;
  border: 1px solid #333;
  border-radius: 14px;
  overflow: hidden;
}

.label {
  padding: 12px 14px;
  font-weight: 700;
}

img {
  display: block;
  width: 100%;
  height: auto;
  background: #000;
}

.note {
  margin-top: 18px;
  padding: 14px;
  border-radius: 12px;
  background: #191919;
  color: #ccc;
}

@media (
  max-width: 980px
) {
  .grid {
    grid-template-columns:
      1fr;
  }
}
</style>

</head>

<body>

<main>

<h1>
${esc(
  listing?.title ||
  `Listing ${listingId}`
)}
</h1>

<p>
Listing ID:
${esc(listingId)}
·
Source image ID:
${esc(
  imageSet.rank1.imageId
)}
</p>

<div class="grid">

<div class="card">
  <div class="label">
    ÖNCE — mevcut Etsy rank 1
  </div>

  <img
    src="${esc(beforeUrl)}"
    alt="Before"
  >
</div>

${rank2Card}

<div class="card">
  <div class="label">
    SONRA — reference-preserving v4 preview
  </div>

  <img
    src="${esc(afterUrl)}"
    alt="After"
  >
</div>

</div>

<div class="note">
Amaç müşteriye başka bir ürün göstermek değildir.
Yeni thumbnail mevcut rank-1 görselinden üretilir.
Crop, perspektif, sahne ve artwork içeriği değiştirilmez.
Image 2 yalnızca galeri tutarlılığı referansıdır.
Bu sayfa Etsy'de hiçbir değişiklik yapmaz.
</div>

</main>

</body>

</html>
        `);

    } catch (err) {
      console.error(err);

      res
        .status(
          err.status ||
          400
        )
        .send(
          err.message
        );
    }
  }
);


/* =========================================================
   API AUTH
========================================================= */

app.use(
  '/api',
  bridgeAuth
);


/* =========================================================
   TOKEN
========================================================= */

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

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   SHOP
========================================================= */

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
          `/shops/${await sid()}`
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


app.patch(
  '/api/shop',
  async (
    req,
    res,
    next
  ) => {
    try {
      const allowed = [
        'title',
        'announcement',
        'sale_message',
        'digital_sale_message',
        'policy_additional'
      ];

      const body =
        Object.fromEntries(
          Object.entries(
            req.body ||
            {}
          ).filter(
            ([key]) =>
              allowed.includes(
                key
              )
          )
        );

      if (
        !Object.keys(
          body
        ).length
      ) {
        return res
          .status(400)
          .json({
            error:
              'No allowed shop fields provided.'
          });
      }

      res.json(
        await etsyRequest(
          `/shops/${await sid()}`,
          {
            method:
              'PUT',

            body
          }
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   LISTINGS
========================================================= */

app.get(
  '/api/listings',
  async (
    req,
    res,
    next
  ) => {
    try {
      const limit =
        Math.max(
          1,
          Math.min(
            Number(
              req.query.limit ||
              25
            ),
            25
          )
        );

      const offset =
        Math.max(
          0,
          Number(
            req.query.offset ||
            0
          )
        );

      const state =
        req.query.state ||
        'active';

      const data =
        await etsyRequest(
          `/shops/${await sid()}/listings`,
          {
            params: {
              limit,
              offset,
              state
            }
          }
        );

      res.json({
        count:
          data?.count ??
          0,

        offset,
        limit,

        results:
          (
            data?.results ||
            []
          ).map(
            (listing) => ({
              listing_id:
                listing.listing_id,

              title:
                listing.title,

              state:
                listing.state,

              num_favorers:
                listing.num_favorers ??
                0,

              created_timestamp:
                listing
                  .original_creation_timestamp ??
                listing
                  .creation_timestamp ??
                listing
                  .created_timestamp ??
                null,

              updated_timestamp:
                listing
                  .updated_timestamp ??
                listing
                  .last_modified_timestamp ??
                null
            })
          )
      });

    } catch (err) {
      next(err);
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
          req.params.listingId
        );

      res.json(
        await etsyRequest(
          `/listings/${listingId}`
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


app.patch(
  '/api/listings/:listingId',
  async (
    req,
    res,
    next
  ) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const allowed = [
        'title',
        'description',
        'tags',
        'materials',
        'shop_section_id',
        'section_id',
        'state',
        'is_customizable',
        'is_personalizable',
        'personalization_is_required',
        'personalization_char_count_max',
        'personalization_instructions'
      ];

      const body =
        Object.fromEntries(
          Object.entries(
            req.body ||
            {}
          ).filter(
            ([key]) =>
              allowed.includes(
                key
              )
          )
        );

      if (
        !Object.keys(
          body
        ).length
      ) {
        return res
          .status(400)
          .json({
            error:
              'No allowed listing fields provided.'
          });
      }

      res.json(
        await etsyRequest(
          `/shops/${await sid()}/listings/${listingId}`,
          {
            method:
              'PATCH',

            body
          }
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   LISTING IMAGES
========================================================= */

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
          req.params.listingId
        );

      res.json(
        await getListingImages(
          listingId
        )
      );

    } catch (err) {
      next(err);
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
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const refs =
        req.body
          ?.openaiFileIdRefs;

      if (
        !Array.isArray(refs) ||
        refs.length !== 1
      ) {
        return res
          .status(400)
          .json({
            error:
              'Exactly one image file is required'
          });
      }

      const fileRef =
        refs[0];

      if (
        !fileRef ||
        typeof fileRef !==
          'object' ||
        typeof fileRef
          .download_link !==
          'string'
      ) {
        return res
          .status(400)
          .json({
            error:
              'Valid OpenAI file reference with download_link is required'
          });
      }

      const fileUrl =
        new URL(
          fileRef.download_link
        );

      if (
        fileUrl.protocol !==
        'https:'
      ) {
        return res
          .status(400)
          .json({
            error:
              'Image download link must use HTTPS'
          });
      }

      const response =
        await fetch(
          fileRef.download_link
        );

      if (!response.ok) {
        return res
          .status(400)
          .json({
            error:
              `Could not download image (${response.status})`
          });
      }

      const imageBuffer =
        Buffer.from(
          await response.arrayBuffer()
        );

      const contentType =
        fileRef.mime_type ||
        response.headers.get(
          'content-type'
        ) ||
        'image/jpeg';

      if (
        !contentType.startsWith(
          'image/'
        )
      ) {
        return res
          .status(400)
          .json({
            error:
              'Uploaded file must be an image'
          });
      }

      const data =
        await uploadListingImage({
          shopId:
            await sid(),

          listingId,

          imageBuffer,

          filename:
            fileRef.name ||
            'image.jpg',

          contentType
        });

      res.json(data);

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   SINGLE THUMBNAIL ANALYSIS
========================================================= */

app.get(
  '/api/listings/:listingId/thumbnail-analysis',
  async (
    req,
    res,
    next
  ) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const listing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const imageSet =
        await getListingImageSet(
          listingId
        );

      const {
        buffer
      } =
        await downloadImage(
          imageSet.rank1.imageUrl
        );

      const analysis =
        await analyzeImage(
          buffer
        );

      const assessment =
        assessThumbnail(
          analysis
        );

      res.json({
        listing_id:
          Number(listingId),

        exact_title:
          listing?.title ??
          null,

        image_id:
          imageSet.rank1.imageId,

        rank:
          imageSet.rank1.image.rank ??
          null,

        image_url:
          imageSet.rank1.imageUrl,

        image2_reference_id:
          imageSet.rank2?.imageId ??
          null,

        image2_reference_url:
          imageSet.rank2?.imageUrl ??
          null,

        analysis,
        assessment,

        etsy_modified:
          false
      });

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   WORKER SCAN
   READ ONLY
========================================================= */

app.get(
  '/api/worker/scan',
  async (
    req,
    res,
    next
  ) => {
    try {
      const offset =
        Math.max(
          0,
          Number(
            req.query.offset ||
            0
          )
        );

      const limit =
        Math.max(
          1,
          Math.min(
            Number(
              req.query.limit ||
              8
            ),
            SCAN_MAX_LIMIT
          )
        );

      const data =
        await etsyRequest(
          `/shops/${await sid()}/listings`,
          {
            params: {
              limit,
              offset,
              state:
                'active'
            }
          }
        );

      const listings =
        data?.results ||
        [];

      const scanned =
        await mapLimit(
          listings,
          3,
          async (
            listing
          ) => {
            try {
              const listingId =
                String(
                  listing.listing_id
                );

              const imageSet =
                await getListingImageSet(
                  listingId
                );

              const {
                buffer
              } =
                await downloadImage(
                  imageSet.rank1.imageUrl
                );

              const analysis =
                await analyzeImage(
                  buffer
                );

              const assessment =
                assessThumbnail(
                  analysis
                );

              const performance =
                performanceSignal(
                  listing
                );

              return {
                listing_id:
                  listing.listing_id,

                exact_title:
                  listing.title,

                state:
                  listing.state,

                rank1_image_id:
                  imageSet.rank1.imageId,

                rank1_image_url:
                  imageSet.rank1.imageUrl,

                image2_reference_id:
                  imageSet.rank2?.imageId ??
                  null,

                image2_reference_url:
                  imageSet.rank2?.imageUrl ??
                  null,

                analysis,
                assessment,

                available_performance_signal:
                  performance,

                note:
                  'Only available Etsy listing signals are used. Missing CTR, conversion or view data is never invented.'
              };

            } catch (err) {
              return {
                listing_id:
                  listing.listing_id,

                exact_title:
                  listing.title,

                error:
                  err.message,

                assessment: {
                  priority:
                    'review',

                  recommended_action:
                    'manual_review'
                }
              };
            }
          }
        );

      const priorityOrder = {
        urgent: 0,
        high: 1,
        review: 2,
        none: 3
      };

      scanned.sort(
        (
          a,
          b
        ) => {
          const pa =
            priorityOrder[
              a?.assessment
                ?.priority
            ] ?? 9;

          const pb =
            priorityOrder[
              b?.assessment
                ?.priority
            ] ?? 9;

          if (
            pa !== pb
          ) {
            return (
              pa - pb
            );
          }

          const sa =
            a?.assessment
              ?.readability_score_0_100 ??
            100;

          const sb =
            b?.assessment
              ?.readability_score_0_100 ??
            100;

          return (
            sa - sb
          );
        }
      );

      const total =
        Number(
          data?.count ??
          listings.length
        );

      const nextOffset =
        offset +
        listings.length;

      res.json({
        scan_mode:
          'read_only',

        etsy_modified:
          false,

        count:
          total,

        offset,
        limit,

        scanned_count:
          scanned.length,

        next_offset:
          nextOffset <
          total
            ? nextOffset
            : null,

        has_more:
          nextOffset <
          total,

        results:
          scanned
      });

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   V4 PREVIEW
   READ ONLY
========================================================= */

app.post(
  '/api/listings/:listingId/thumbnail-repair/preview',
  async (
    req,
    res,
    next
  ) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const mode =
        normalizeRepairMode(
          req.body?.mode
        );

      const preview =
        await buildRepairPreview(
          listingId,
          mode
        );

      res.json({
        listing_id:
          Number(listingId),

        exact_title:
          preview.listing?.title ??
          null,

        source_image_id:
          preview.imageSet.rank1.imageId,

        source_image_url:
          preview.imageSet.rank1.imageUrl,

        image2_reference_id:
          preview.imageSet.rank2?.imageId ??
          null,

        image2_reference_url:
          preview.imageSet.rank2?.imageUrl ??
          null,

        preview_file_name:
          `etsy-${listingId}-reference-preserving-v4.jpg`,

        preview_url:
          `${publicBase()}/preview/thumbnail-repair/${preview.token}`,

        compare_url:
          `${publicBase()}/preview/thumbnail-repair/${preview.token}/compare`,

        before:
          preview.before,

        after:
          preview.after,

        image2_reference_analysis:
          preview.rank2Analysis,

        assessment:
          preview.assessment,

        validation:
          preview.validation,

        visual_consistency:
          preview.galleryConsistency,

        repair: {
          type:
            'reference_preserving_shadow_lift_v4',

          mode:
            preview.mode,

          target_brightness:
            preview.target,

          strength:
            preview.strength,

          geometry_changed:
            false,

          crop_changed:
            false,

          perspective_changed:
            false,

          generative_redraw_used:
            false,

          artwork_content_changed:
            false,

          color_identity_preservation:
            true,

          mockup_structure_changed:
            false,

          note:
            'The current Etsy rank 1 image remains the visual source. Only luminance-dependent shadow and mid-shadow recovery is applied.'
        },

        preview_token:
          preview.token,

        expires_in_seconds:
          Math.round(
            PREVIEW_TTL_MS /
            1000
          ),

        approval_required_for_upload:
          'ONAYLIYORUM',

        upload_blocked_by_consistency:
          (
            !preview.validation
              .safe_for_visual_review ||
            !preview.galleryConsistency
              .passed
          ),

        etsy_modified:
          false
      });

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   APPLY V4
   EXACT ONAYLIYORUM REQUIRED
========================================================= */

app.post(
  '/api/listings/:listingId/thumbnail-repair/apply',
  async (
    req,
    res,
    next
  ) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const approval =
        String(
          req.body?.approval ||
          ''
        ).trim();

      const previewToken =
        String(
          req.body?.preview_token ||
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
              'Exact approval text ONAYLIYORUM is required'
          });
      }

      const payload =
        verifyToken(
          previewToken,
          'thumbnail_preview_v4'
        );

      if (
        String(
          payload.listingId
        ) !==
        listingId
      ) {
        return res
          .status(409)
          .json({
            error:
              'Preview token belongs to another listing'
          });
      }

      const listing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const imageSet =
        await getListingImageSet(
          listingId
        );

      if (
        String(
          imageSet.rank1.imageId
        ) !==
        String(
          payload.sourceImageId
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Current rank 1 image changed after preview; create a new preview and approve again'
          });
      }

      if (
        payload.rank2ImageId
      ) {
        const currentRank2Id =
          imageSet.rank2?.imageId
            ? String(
                imageSet.rank2.imageId
              )
            : null;

        if (
          currentRank2Id !==
          String(
            payload.rank2ImageId
          )
        ) {
          return res
            .status(409)
            .json({
              error:
                'Image 2 reference changed after preview; create a new preview and approve again'
            });
        }
      }

      const {
        buffer:
          sourceBuffer
      } =
        await downloadImage(
          imageSet.rank1.imageUrl
        );

      const before =
        await analyzeImage(
          sourceBuffer
        );

      let rank2Analysis =
        null;

      if (
        imageSet.rank2?.imageUrl
      ) {
        try {
          const {
            buffer:
              rank2Buffer
          } =
            await downloadImage(
              imageSet.rank2.imageUrl
            );

          rank2Analysis =
            await analyzeImage(
              rank2Buffer
            );

        } catch (err) {
          console.warn(
            'Image 2 reference could not be re-analyzed:',
            err.message
          );
        }
      }

      const repaired =
        Number(
          payload.strength
        ) > 0
          ? await renderLiftV4(
              sourceBuffer,
              Number(
                payload.strength
              )
            )
          : sourceBuffer;

      const after =
        await analyzeImage(
          repaired
        );

      const validation =
        validateRepairResult(
          before,
          after
        );

      const galleryConsistency =
        assessGalleryConsistency(
          before,
          after,
          rank2Analysis
        );

      if (
        !validation
          .safe_for_visual_review ||
        !galleryConsistency
          .passed
      ) {
        return res
          .status(409)
          .json({
            error:
              'Visual consistency safety check failed before upload',

            before,
            after,

            validation,

            visual_consistency:
              galleryConsistency,

            etsy_modified:
              false
          });
      }

      const uploadResult =
        await uploadListingImage({
          shopId:
            await sid(),

          listingId,

          imageBuffer:
            repaired,

          filename:
            `etsy-${listingId}-reference-preserving-v4.jpg`,

          contentType:
            'image/jpeg'
        });

      const uploadedRecord =
        extractUploadedImage(
          uploadResult
        );

      const uploadedImageId =
        getImageId(
          uploadedRecord
        );

      const postImagesData =
        await getListingImages(
          listingId
        );

      const postImages =
        postImagesData?.results ||
        [];

      const currentRank1 =
        postImages.find(
          (img) =>
            Number(
              img.rank
            ) === 1
        ) ||
        [...postImages]
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
          )[0] ||
        null;

      const currentRank1Id =
        getImageId(
          currentRank1
        );

      const newImageExists =
        uploadedImageId
          ? postImages.some(
              (img) =>
                String(
                  getImageId(img)
                ) ===
                String(
                  uploadedImageId
                )
            )
          : false;

      const newImageIsRank1 =
        Boolean(
          uploadedImageId &&
          String(
            currentRank1Id
          ) ===
          String(
            uploadedImageId
          )
        );

      let cleanupToken =
        null;

      if (
        newImageExists &&
        newImageIsRank1
      ) {
        cleanupToken =
          signToken({
            type:
              'thumbnail_cleanup_v1',

            listingId,

            sourceImageId:
              String(
                imageSet.rank1.imageId
              ),

            replacementImageId:
              String(
                uploadedImageId
              ),

            exp:
              Date.now() +
              CLEANUP_TTL_MS
          });
      }

      res.json({
        success:
          Boolean(
            newImageExists &&
            newImageIsRank1
          ),

        exact_title:
          listing?.title ??
          null,

        listing_id:
          Number(listingId),

        source_image_id:
          imageSet.rank1.imageId,

        source_image_url:
          imageSet.rank1.imageUrl,

        image2_reference_id:
          imageSet.rank2?.imageId ??
          null,

        uploaded_image_id:
          uploadedImageId,

        current_rank1_image_id:
          currentRank1Id,

        replacement_verified_as_rank1:
          newImageIsRank1,

        before,
        after,

        validation,

        visual_consistency:
          galleryConsistency,

        existing_images_deleted:
          false,

        listing_fields_changed:
          false,

        current_images:
          compactImageList(
            postImagesData
          ),

        cleanup_available:
          Boolean(
            cleanupToken
          ),

        cleanup_token:
          cleanupToken,

        cleanup_requires_exact_approval:
          cleanupToken
            ? 'TEMIZLIGI_ONAYLIYORUM'
            : null,

        warning:
          newImageIsRank1
            ? 'Replacement is verified as rank 1. Old source image remains until separate cleanup approval.'
            : 'Upload returned, but replacement was not verified as rank 1. Cleanup is blocked.'
      });

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   OLD THUMBNAIL CLEANUP
   SEPARATE APPROVAL REQUIRED
========================================================= */

app.post(
  '/api/listings/:listingId/thumbnail-repair/cleanup',
  async (
    req,
    res,
    next
  ) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const approval =
        String(
          req.body?.approval ||
          ''
        ).trim();

      const cleanupToken =
        String(
          req.body?.cleanup_token ||
          ''
        ).trim();

      if (
        approval !==
        'TEMIZLIGI_ONAYLIYORUM'
      ) {
        return res
          .status(400)
          .json({
            error:
              'Exact approval text TEMIZLIGI_ONAYLIYORUM is required'
          });
      }

      const payload =
        verifyToken(
          cleanupToken,
          'thumbnail_cleanup_v1'
        );

      if (
        String(
          payload.listingId
        ) !==
        listingId
      ) {
        return res
          .status(409)
          .json({
            error:
              'Cleanup token belongs to another listing'
          });
      }

      const beforeData =
        await getListingImages(
          listingId
        );

      const images =
        beforeData?.results ||
        [];

      if (
        images.length < 2
      ) {
        return res
          .status(409)
          .json({
            error:
              'Cleanup blocked because listing has fewer than two images'
          });
      }

      const source =
        images.find(
          (img) =>
            String(
              getImageId(img)
            ) ===
            String(
              payload.sourceImageId
            )
        );

      const replacement =
        images.find(
          (img) =>
            String(
              getImageId(img)
            ) ===
            String(
              payload.replacementImageId
            )
        );

      const rank1 =
        images.find(
          (img) =>
            Number(
              img.rank
            ) === 1
        ) ||
        null;

      if (!source) {
        return res
          .status(409)
          .json({
            error:
              'Old source image is no longer attached; nothing was deleted'
          });
      }

      if (!replacement) {
        return res
          .status(409)
          .json({
            error:
              'Replacement image is missing; cleanup blocked'
          });
      }

      if (
        String(
          getImageId(rank1)
        ) !==
        String(
          payload.replacementImageId
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Replacement is not the current rank 1 image; cleanup blocked'
          });
      }

      if (
        String(
          getImageId(source)
        ) ===
        String(
          getImageId(rank1)
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Source image is still rank 1; cleanup blocked'
          });
      }

      const variationData =
        await etsyRequest(
          `/shops/${await sid()}/listings/${listingId}/variation-images`
        ).catch(
          () => ({
            results: []
          })
        );

      const sourceUsedByVariation =
        (
          variationData?.results ||
          []
        ).some(
          (item) =>
            String(
              item?.image_id
            ) ===
            String(
              payload.sourceImageId
            )
        );

      if (
        sourceUsedByVariation
      ) {
        return res
          .status(409)
          .json({
            error:
              'Old source image is used by a listing variation; cleanup blocked for safety'
          });
      }

      try {
        await etsyRequest(
          `/shops/${await sid()}/listings/${listingId}/images/${payload.sourceImageId}`,
          {
            method:
              'DELETE'
          }
        );

      } catch (deleteErr) {
        /*
          Etsy can return 204 No Content.
          Some wrappers may dislike an empty body.
          Re-read images before declaring failure.
        */

        const probe =
          await getListingImages(
            listingId
          ).catch(
            () => null
          );

        const stillExists =
          (
            probe?.results ||
            []
          ).some(
            (img) =>
              String(
                getImageId(img)
              ) ===
              String(
                payload.sourceImageId
              )
          );

        if (
          !probe ||
          stillExists
        ) {
          throw deleteErr;
        }
      }

      const afterData =
        await getListingImages(
          listingId
        );

      const afterImages =
        afterData?.results ||
        [];

      const sourceStillExists =
        afterImages.some(
          (img) =>
            String(
              getImageId(img)
            ) ===
            String(
              payload.sourceImageId
            )
        );

      const replacementAfter =
        afterImages.find(
          (img) =>
            String(
              getImageId(img)
            ) ===
            String(
              payload.replacementImageId
            )
        );

      res.json({
        success:
          Boolean(
            !sourceStillExists &&
            Number(
              replacementAfter?.rank
            ) === 1
          ),

        listing_id:
          Number(listingId),

        deleted_old_source_image_id:
          payload.sourceImageId,

        replacement_image_id:
          payload.replacementImageId,

        replacement_rank_after_cleanup:
          replacementAfter?.rank ??
          null,

        old_source_still_present:
          sourceStillExists,

        current_images:
          compactImageList(
            afterData
          ),

        listing_fields_changed:
          false
      });

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   SECTIONS
========================================================= */

app.get(
  '/api/sections',
  async (
    _req,
    res,
    next
  ) => {
    try {
      res.json(
        await etsyRequest(
          `/shops/${await sid()}/sections`
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


app.post(
  '/api/sections',
  async (
    req,
    res,
    next
  ) => {
    try {
      const title =
        String(
          req.body?.title ||
          ''
        ).trim();

      if (!title) {
        return res
          .status(400)
          .json({
            error:
              'title is required'
          });
      }

      res.json(
        await etsyRequest(
          `/shops/${await sid()}/sections`,
          {
            method:
              'POST',

            body: {
              title
            }
          }
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


app.put(
  '/api/sections/:sectionId',
  async (
    req,
    res,
    next
  ) => {
    try {
      const sectionId =
        asSectionId(
          req.params.sectionId
        );

      const title =
        String(
          req.body?.title ||
          ''
        ).trim();

      if (!title) {
        return res
          .status(400)
          .json({
            error:
              'title is required'
          });
      }

      res.json(
        await etsyRequest(
          `/shops/${await sid()}/sections/${sectionId}`,
          {
            method:
              'PUT',

            body: {
              title
            }
          }
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


/* =========================================================
   ERROR HANDLER
========================================================= */

app.use(
  (
    err,
    _req,
    res,
    _next
  ) => {
    console.error(err);

    res
      .status(
        err.status ||
        500
      )
      .json({
        error:
          err.message ||
          'internal_error',

        details:
          err.details ||
          null
      });
  }
);


export default app;


if (
  !process.env.VERCEL
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
        `VAELONS Etsy Seller bridge listening on :${port}`
      );
    }
  );
}
