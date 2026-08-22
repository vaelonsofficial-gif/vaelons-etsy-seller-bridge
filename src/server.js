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

const DETECTOR_TTL_MS = 60 * 60 * 1000;
const TRANSFER_PREVIEW_TTL_MS = 30 * 60 * 1000;
const CLEANUP_TTL_MS = 24 * 60 * 60 * 1000;
const SCAN_MAX_LIMIT = 10;

const FRAME_APPROVAL = 'FRAME_ONAYLIYORUM';
const PUBLISH_APPROVAL = 'ONAYLIYORUM';
const CLEANUP_APPROVAL = 'TEMIZLIGI_ONAYLIYORUM';

const MIN_MANUAL_FRAME_CONFIDENCE = 0.25;

/*
  v5.4 COVER-FIT SETTINGS

  Artwork is allowed to crop slightly in order to fill the hero frame.
  No stretching is used.

  > 12% crop = warning
  > 22% crop = hard block
*/
const COVER_CROP_WARNING = 0.12;
const COVER_CROP_HARD_LIMIT = 0.22;

/*
  Artwork extends nearly to the detected outer-frame edges.

  The original frame border is then restored on top.
  This prevents old Rank-1 artwork from remaining as a visible strip.
*/
const HERO_ARTWORK_BLEED_INSET = 0.012;

/*
  Amount of original Rank-1 frame restored over the transferred artwork.
  Keep this deliberately narrow to avoid restoring old artwork pixels.
*/
const FRAME_RING_X_RATIO = 0.028;
const FRAME_RING_Y_RATIO = 0.028;

/* =========================================================
   BASIC
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
  return required(
    'PUBLIC_BASE_URL'
  ).replace(/\/$/, '');
}

function bridgeAuth(
  req,
  res,
  next
) {
  const auth =
    req.get(
      'authorization'
    ) || '';

  if (
    auth !==
    `Bearer ${required('BRIDGE_API_KEY')}`
  ) {
    return res
      .status(401)
      .json({
        error:
          'unauthorized'
      });
  }

  next();
}

function parseCookies(req) {
  const result = {};

  for (
    const part of
    (
      req.headers.cookie ||
      ''
    ).split(';')
  ) {
    const idx =
      part.indexOf('=');

    if (idx > -1) {
      result[
        part
          .slice(0, idx)
          .trim()
      ] =
        decodeURIComponent(
          part
            .slice(idx + 1)
            .trim()
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
  const id =
    String(
      value || ''
    ).trim();

  if (
    !/^\d+$/.test(id)
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

function asSectionId(value) {
  const id =
    String(
      value || ''
    ).trim();

  if (
    !/^\d+$/.test(id)
  ) {
    const err =
      new Error(
        'Invalid sectionId'
      );

    err.status =
      400;

    throw err;
  }

  return id;
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
      value
    )
  );
}

function round1(value) {
  return (
    Math.round(
      Number(value) *
      10
    ) /
    10
  );
}

function round2(value) {
  return (
    Math.round(
      Number(value) *
      100
    ) /
    100
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

function extractUploadedImage(
  uploadResult
) {
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
   LISTING IMAGES
========================================================= */

async function getListingImageSet(
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

  if (!images.length) {
    const err =
      new Error(
        'No listing images found'
      );

    err.status = 404;
    throw err;
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
        ) === 1
    ) ||
    ordered[0];

  const rank2 =
    images.find(
      (img) =>
        Number(
          img.rank
        ) === 2
    ) ||
    ordered[1] ||
    null;

  const rank1Url =
    getImageUrl(
      rank1
    );

  const rank2Url =
    rank2
      ? getImageUrl(
          rank2
        )
      : null;

  if (!rank1Url) {
    const err =
      new Error(
        'No usable rank 1 image URL found'
      );

    err.status = 404;
    throw err;
  }

  return {
    images,

    rank1: {
      image:
        rank1,

      imageId:
        getImageId(
          rank1
        ),

      imageUrl:
        rank1Url
    },

    rank2:
      rank2 &&
      rank2Url
        ? {
            image:
              rank2,

            imageId:
              getImageId(
                rank2
              ),

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
    parsed.protocol !==
    'https:'
  ) {
    const err =
      new Error(
        'Image URL must use HTTPS'
      );

    err.status = 400;
    throw err;
  }

  const response =
    await fetch(url);

  if (!response.ok) {
    const err =
      new Error(
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
    20 *
    1024 *
    1024
  ) {
    const err =
      new Error(
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
        (
          values.length -
          1
        ) *
        fraction
      ),
      0,
      values.length -
      1
    );

  return values[index];
}

async function analyzeImage(
  buffer
) {
  const metadata =
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
      .toColourspace(
        'srgb'
      )
      .resize({
        width:
          420,

        height:
          420,

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

  const channels =
    info.channels;

  const values = [];

  let sumL = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumChroma = 0;

  let shadowCount = 0;
  let deepShadowCount = 0;
  let highlightCount = 0;
  let count = 0;

  for (
    let i = 0;
    i < data.length;
    i += channels
  ) {
    const r =
      data[i];

    const g =
      data[
        i + 1
      ];

    const b =
      data[
        i + 2
      ];

    const y =
      Math.round(
        0.2126 * r +
        0.7152 * g +
        0.0722 * b
      );

    values.push(y);

    sumL += y;
    sumR += r;
    sumG += g;
    sumB += b;

    sumChroma +=
      Math.max(
        r,
        g,
        b
      ) -
      Math.min(
        r,
        g,
        b
      );

    if (y < 55) {
      shadowCount += 1;
    }

    if (y < 28) {
      deepShadowCount += 1;
    }

    if (y > 230) {
      highlightCount += 1;
    }

    count += 1;
  }

  values.sort(
    (
      a,
      b
    ) =>
      a - b
  );

  const safeCount =
    count || 1;

  const brightness =
    Math.round(
      sumL /
      safeCount
    );

  let variance = 0;

  for (
    const value of
    values
  ) {
    const delta =
      value -
      brightness;

    variance +=
      delta *
      delta;
  }

  const contrast =
    Math.round(
      Math.sqrt(
        variance /
        safeCount
      )
    );

  const p10 =
    percentileFromSorted(
      values,
      0.10
    );

  const p50 =
    percentileFromSorted(
      values,
      0.50
    );

  const p90 =
    percentileFromSorted(
      values,
      0.90
    );

  let darknessLabel =
    'good';

  if (
    brightness < 60
  ) {
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
      p90 -
      p10,

    shadow_percent:
      round1(
        shadowCount /
        safeCount *
        100
      ),

    deep_shadow_percent:
      round1(
        deepShadowCount /
        safeCount *
        100
      ),

    highlight_percent:
      round1(
        highlightCount /
        safeCount *
        100
      ),

    mean_rgb: {
      r:
        round1(
          sumR /
          safeCount
        ),

      g:
        round1(
          sumG /
          safeCount
        ),

      b:
        round1(
          sumB /
          safeCount
        )
    },

    mean_chroma:
      round1(
        sumChroma /
        safeCount
      )
  };
}

function assessThumbnail(
  analysis
) {
  let score = 100;

  const b =
    analysis
      .brightness_0_255;

  const shadows =
    analysis
      .shadow_percent;

  const deep =
    analysis
      .deep_shadow_percent;

  const highlights =
    analysis
      .highlight_percent;

  const range =
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
  } else if (shadows > 50) {
    score -= 17;
  } else if (shadows > 40) {
    score -= 10;
  } else if (shadows > 32) {
    score -= 5;
  }

  if (deep > 38) {
    score -= 14;
  } else if (deep > 28) {
    score -= 9;
  } else if (deep > 20) {
    score -= 4;
  }

  if (highlights > 14) {
    score -= 8;
  } else if (highlights > 8) {
    score -= 4;
  }

  if (range < 55) {
    score -= 12;
  } else if (range < 70) {
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

  let action =
    'keep';

  if (
    score < 45
  ) {
    priority =
      'urgent';

    action =
      'inspect_outer_frame_detector';

  } else if (
    score < 60
  ) {
    priority =
      'high';

    action =
      'inspect_outer_frame_detector';

  } else if (
    score < 75
  ) {
    priority =
      'review';

    action =
      'review_before_repair';
  }

  return {
    readability_score_0_100:
      score,

    priority,

    recommended_action:
      action,

    auto_publish_allowed:
      false
  };
}

/* =========================================================
   FRAME DETECTOR
========================================================= */

function buildIntegralImage(
  values,
  width,
  height
) {
  const stride =
    width + 1;

  const integral =
    new Float64Array(
      (
        width +
        1
      ) *
      (
        height +
        1
      )
    );

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    let rowSum = 0;

    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      rowSum +=
        values[
          y *
          width +
          x
        ];

      integral[
        (
          y +
          1
        ) *
        stride +
        (
          x +
          1
        )
      ] =
        integral[
          y *
          stride +
          (
            x +
            1
          )
        ] +
        rowSum;
    }
  }

  return {
    integral,
    stride,
    width,
    height
  };
}

function rectSum(
  map,
  x,
  y,
  width,
  height
) {
  const x1 =
    clamp(
      Math.round(x),
      0,
      map.width -
      1
    );

  const y1 =
    clamp(
      Math.round(y),
      0,
      map.height -
      1
    );

  const x2 =
    clamp(
      Math.round(
        x +
        width
      ),
      x1 + 1,
      map.width
    );

  const y2 =
    clamp(
      Math.round(
        y +
        height
      ),
      y1 + 1,
      map.height
    );

  const {
    integral,
    stride
  } =
    map;

  return (
    integral[
      y2 *
      stride +
      x2
    ] -
    integral[
      y1 *
      stride +
      x2
    ] -
    integral[
      y2 *
      stride +
      x1
    ] +
    integral[
      y1 *
      stride +
      x1
    ]
  );
}

function rectMean(
  map,
  x,
  y,
  width,
  height
) {
  const x1 =
    clamp(
      Math.round(x),
      0,
      map.width -
      1
    );

  const y1 =
    clamp(
      Math.round(y),
      0,
      map.height -
      1
    );

  const x2 =
    clamp(
      Math.round(
        x +
        width
      ),
      x1 + 1,
      map.width
    );

  const y2 =
    clamp(
      Math.round(
        y +
        height
      ),
      y1 + 1,
      map.height
    );

  return (
    rectSum(
      map,
      x1,
      y1,
      x2 - x1,
      y2 - y1
    ) /
    Math.max(
      (
        x2 -
        x1
      ) *
      (
        y2 -
        y1
      ),
      1
    )
  );
}

function generateFractions(
  start,
  end,
  step
) {
  const values = [];

  for (
    let value = start;
    value <=
      end +
      0.0001;
    value +=
      step
  ) {
    values.push(
      Number(
        value.toFixed(4)
      )
    );
  }

  return values;
}

function segmentMeansHorizontal(
  map,
  x,
  y,
  width,
  strip,
  segments = 9
) {
  const means = [];

  const segmentWidth =
    width /
    segments;

  for (
    let i = 0;
    i < segments;
    i += 1
  ) {
    means.push(
      rectMean(
        map,
        x +
        i *
        segmentWidth,
        y,
        segmentWidth,
        strip
      )
    );
  }

  return means;
}

function segmentMeansVertical(
  map,
  x,
  y,
  strip,
  height,
  segments = 9
) {
  const means = [];

  const segmentHeight =
    height /
    segments;

  for (
    let i = 0;
    i < segments;
    i += 1
  ) {
    means.push(
      rectMean(
        map,
        x,
        y +
        i *
        segmentHeight,
        strip,
        segmentHeight
      )
    );
  }

  return means;
}

function percentile(
  values,
  fraction
) {
  if (!values.length) {
    return 0;
  }

  const sorted =
    [...values].sort(
      (
        a,
        b
      ) =>
        a - b
    );

  const idx =
    clamp(
      Math.round(
        (
          sorted.length -
          1
        ) *
        fraction
      ),
      0,
      sorted.length -
      1
    );

  return sorted[idx];
}

function continuityScore(
  values,
  baseline
) {
  const safeBase =
    Math.max(
      baseline,
      0.001
    );

  const ratios =
    values.map(
      (value) =>
        value /
        safeBase
    );

  const p25 =
    percentile(
      ratios,
      0.25
    );

  const median =
    percentile(
      ratios,
      0.50
    );

  const strongSegments =
    ratios.filter(
      (ratio) =>
        ratio >=
        1.15
    ).length /
    Math.max(
      ratios.length,
      1
    );

  return {
    score:
      clamp(
        (
          p25 -
          0.85
        ) /
        1.6,
        0,
        1
      ) *
      0.45 +

      clamp(
        (
          median -
          1
        ) /
        1.8,
        0,
        1
      ) *
      0.30 +

      strongSegments *
      0.25
  };
}

function candidateDirectionalScore(
  candidate,
  maps,
  role
) {
  const {
    x,
    y,
    width,
    height
  } =
    candidate;

  const minSide =
    Math.min(
      width,
      height
    );

  const strip =
    Math.max(
      2,
      Math.round(
        minSide *
        0.015
      )
    );

  const cornerSize =
    Math.max(
      strip * 4,
      Math.round(
        minSide *
        0.055
      )
    );

  const topSegments =
    segmentMeansHorizontal(
      maps.horizontal,
      x,
      y,
      width,
      strip
    );

  const bottomSegments =
    segmentMeansHorizontal(
      maps.horizontal,
      x,
      y +
      height -
      strip,
      width,
      strip
    );

  const leftSegments =
    segmentMeansVertical(
      maps.vertical,
      x,
      y,
      strip,
      height
    );

  const rightSegments =
    segmentMeansVertical(
      maps.vertical,
      x +
      width -
      strip,
      y,
      strip,
      height
    );

  const topCont =
    continuityScore(
      topSegments,
      maps.horizontalMean
    );

  const bottomCont =
    continuityScore(
      bottomSegments,
      maps.horizontalMean
    );

  const leftCont =
    continuityScore(
      leftSegments,
      maps.verticalMean
    );

  const rightCont =
    continuityScore(
      rightSegments,
      maps.verticalMean
    );

  const borderContinuities =
    [
      topCont.score,
      bottomCont.score,
      leftCont.score,
      rightCont.score
    ];

  const weakestContinuity =
    Math.min(
      ...borderContinuities
    );

  const avgContinuity =
    borderContinuities.reduce(
      (
        a,
        b
      ) =>
        a + b,
      0
    ) /
    borderContinuities.length;

  const topMean =
    topSegments.reduce(
      (
        a,
        b
      ) =>
        a + b,
      0
    ) /
    topSegments.length;

  const bottomMean =
    bottomSegments.reduce(
      (
        a,
        b
      ) =>
        a + b,
      0
    ) /
    bottomSegments.length;

  const leftMean =
    leftSegments.reduce(
      (
        a,
        b
      ) =>
        a + b,
      0
    ) /
    leftSegments.length;

  const rightMean =
    rightSegments.reduce(
      (
        a,
        b
      ) =>
        a + b,
      0
    ) /
    rightSegments.length;

  const horizontalStrength =
    (
      (
        topMean +
        bottomMean
      ) /
      2
    ) /
    Math.max(
      maps.horizontalMean,
      0.001
    );

  const verticalStrength =
    (
      (
        leftMean +
        rightMean
      ) /
      2
    ) /
    Math.max(
      maps.verticalMean,
      0.001
    );

  const weakestDirectionalStrength =
    Math.min(
      topMean /
      Math.max(
        maps.horizontalMean,
        0.001
      ),

      bottomMean /
      Math.max(
        maps.horizontalMean,
        0.001
      ),

      leftMean /
      Math.max(
        maps.verticalMean,
        0.001
      ),

      rightMean /
      Math.max(
        maps.verticalMean,
        0.001
      )
    );

  const cornerMeans =
    [
      rectMean(
        maps.total,
        x,
        y,
        cornerSize,
        cornerSize
      ),

      rectMean(
        maps.total,
        x +
        width -
        cornerSize,
        y,
        cornerSize,
        cornerSize
      ),

      rectMean(
        maps.total,
        x,
        y +
        height -
        cornerSize,
        cornerSize,
        cornerSize
      ),

      rectMean(
        maps.total,
        x +
        width -
        cornerSize,
        y +
        height -
        cornerSize,
        cornerSize,
        cornerSize
      )
    ];

  const cornerSupport =
    percentile(
      cornerMeans.map(
        (value) =>
          value /
          Math.max(
            maps.totalMean,
            0.001
          )
      ),
      0.25
    );

  const innerMargin =
    Math.max(
      strip * 5,
      Math.round(
        minSide *
        0.07
      )
    );

  const innerWidth =
    Math.max(
      1,
      width -
      innerMargin * 2
    );

  const innerHeight =
    Math.max(
      1,
      height -
      innerMargin * 2
    );

  const innerEdgeMean =
    rectMean(
      maps.total,
      x +
      innerMargin,
      y +
      innerMargin,
      innerWidth,
      innerHeight
    );

  const borderVsInside =
    (
      (
        topMean +
        bottomMean +
        leftMean +
        rightMean
      ) /
      4
    ) /
    Math.max(
      innerEdgeMean,
      0.001
    );

  const areaRatio =
    width *
    height /
    (
      maps.width *
      maps.height
    );

  const centerX =
    (
      x +
      width / 2
    ) /
    maps.width;

  const centerY =
    (
      y +
      height / 2
    ) /
    maps.height;

  const centerPenalty =
    Math.abs(
      centerX -
      0.5
    ) *
    1.35 +

    Math.abs(
      centerY -
      0.47
    ) *
    0.85;

  const outerSizeBonus =
    clamp(
      (
        areaRatio -
        0.18
      ) /
      0.34,
      0,
      1
    );

  const reachBonus =
    clamp(
      (
        (
          width /
          maps.width +
          height /
          maps.height
        ) /
        2 -
        0.42
      ) /
      0.32,
      0,
      1
    );

  const score =
    avgContinuity *
    1.65 +

    weakestContinuity *
    1.15 +

    clamp(
      (
        horizontalStrength -
        0.9
      ) /
      2.2,
      0,
      1
    ) *
    0.70 +

    clamp(
      (
        verticalStrength -
        0.9
      ) /
      2.2,
      0,
      1
    ) *
    0.70 +

    clamp(
      (
        weakestDirectionalStrength -
        0.75
      ) /
      1.9,
      0,
      1
    ) *
    0.75 +

    clamp(
      (
        cornerSupport -
        0.85
      ) /
      1.8,
      0,
      1
    ) *
    0.55 +

    clamp(
      (
        borderVsInside -
        0.8
      ) /
      1.6,
      0,
      1
    ) *
    0.35 +

    outerSizeBonus *
    1.05 +

    reachBonus *
    0.55 -

    centerPenalty;

  return {
    score,
    areaRatio,

    aspect:
      width /
      height,

    avgContinuity,
    weakestContinuity,
    horizontalStrength,
    verticalStrength,
    weakestDirectionalStrength,
    cornerSupport,
    borderVsInside
  };
}

function candidateDistance(
  a,
  b,
  imageWidth,
  imageHeight
) {
  return (
    Math.abs(
      a.x -
      b.x
    ) /
    imageWidth +

    Math.abs(
      a.y -
      b.y
    ) /
    imageHeight +

    Math.abs(
      a.width -
      b.width
    ) /
    imageWidth +

    Math.abs(
      a.height -
      b.height
    ) /
    imageHeight
  );
}

async function detectOuterFrame(
  buffer,
  role
) {
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
          720,

        height:
          720,

        fit:
          'inside',

        withoutEnlargement:
          false
      })
      .raw()
      .toBuffer({
        resolveWithObject:
          true
      });

  const width =
    info.width;

  const height =
    info.height;

  const verticalEdges =
    new Float32Array(
      width *
      height
    );

  const horizontalEdges =
    new Float32Array(
      width *
      height
    );

  const totalEdges =
    new Float32Array(
      width *
      height
    );

  let verticalSum = 0;
  let horizontalSum = 0;
  let totalSum = 0;
  let edgeCount = 0;

  for (
    let y = 1;
    y < height - 1;
    y += 1
  ) {
    for (
      let x = 1;
      x < width - 1;
      x += 1
    ) {
      const idx =
        y *
        width +
        x;

      const gx =
        Math.abs(
          data[
            idx + 1
          ] -
          data[
            idx - 1
          ]
        );

      const gy =
        Math.abs(
          data[
            idx + width
          ] -
          data[
            idx - width
          ]
        );

      verticalEdges[idx] =
        gx;

      horizontalEdges[idx] =
        gy;

      totalEdges[idx] =
        gx + gy;

      verticalSum += gx;
      horizontalSum += gy;
      totalSum += gx + gy;
      edgeCount += 1;
    }
  }

  const maps = {
    width,
    height,

    vertical:
      buildIntegralImage(
        verticalEdges,
        width,
        height
      ),

    horizontal:
      buildIntegralImage(
        horizontalEdges,
        width,
        height
      ),

    total:
      buildIntegralImage(
        totalEdges,
        width,
        height
      ),

    verticalMean:
      verticalSum /
      Math.max(
        edgeCount,
        1
      ),

    horizontalMean:
      horizontalSum /
      Math.max(
        edgeCount,
        1
      ),

    totalMean:
      totalSum /
      Math.max(
        edgeCount,
        1
      )
  };

  const widthFractions =
    generateFractions(
      0.42,
      0.88,
      0.025
    );

  const heightFractions =
    generateFractions(
      0.48,
      0.90,
      0.025
    );

  const centerXOffsets =
    generateFractions(
      -0.075,
      0.075,
      0.025
    );

  const centerYOffsets =
    role ===
    'hero'
      ? generateFractions(
          -0.08,
          0.055,
          0.025
        )
      : generateFractions(
          -0.08,
          0.08,
          0.025
        );

  const candidates = [];

  for (
    const wf of
    widthFractions
  ) {
    for (
      const hf of
      heightFractions
    ) {
      const candidateWidth =
        Math.round(
          wf *
          width
        );

      const candidateHeight =
        Math.round(
          hf *
          height
        );

      const aspect =
        candidateWidth /
        candidateHeight;

      if (
        aspect < 0.48 ||
        aspect > 1.45
      ) {
        continue;
      }

      for (
        const cxOffset of
        centerXOffsets
      ) {
        for (
          const cyOffset of
          centerYOffsets
        ) {
          const centerX =
            width *
            (
              0.5 +
              cxOffset
            );

          const centerY =
            height *
            (
              0.47 +
              cyOffset
            );

          const x =
            Math.round(
              centerX -
              candidateWidth /
              2
            );

          const y =
            Math.round(
              centerY -
              candidateHeight /
              2
            );

          if (
            x <
              width *
              0.02 ||
            y <
              height *
              0.015 ||
            x +
              candidateWidth >
              width *
              0.98 ||
            y +
              candidateHeight >
              height *
              0.97
          ) {
            continue;
          }

          const candidate = {
            x,
            y,

            width:
              candidateWidth,

            height:
              candidateHeight
          };

          const metrics =
            candidateDirectionalScore(
              candidate,
              maps,
              role
            );

          if (
            metrics
              .avgContinuity <
              0.24 ||
            metrics
              .weakestContinuity <
              0.08 ||
            metrics
              .weakestDirectionalStrength <
              0.78
          ) {
            continue;
          }

          candidates.push({
            ...candidate,
            ...metrics
          });
        }
      }
    }
  }

  if (!candidates.length) {
    const err =
      new Error(
        'outer_frame_detector_found_no_candidate'
      );

    err.status = 422;

    err.details = {
      role,

      reason:
        'No sufficiently continuous outer-frame candidate was found.'
    };

    throw err;
  }

  candidates.sort(
    (
      a,
      b
    ) =>
      b.score -
      a.score
  );

  const bestScore =
    candidates[0]
      .score;

  const nearBest =
    candidates
      .filter(
        (candidate) =>
          candidate.score >=
          bestScore -
          0.24
      )
      .sort(
        (
          a,
          b
        ) =>
          Math.abs(
            b.areaRatio -
            a.areaRatio
          ) >
          0.015
            ? b.areaRatio -
              a.areaRatio
            : b.score -
              a.score
      );

  const best =
    nearBest[0];

  let second = null;

  for (
    const candidate of
    candidates
  ) {
    if (
      candidate ===
      best
    ) {
      continue;
    }

    if (
      candidateDistance(
        candidate,
        best,
        width,
        height
      ) >
      0.10
    ) {
      second = candidate;
      break;
    }
  }

  const separation =
    second
      ? clamp(
          (
            best.score -
            second.score
          ) /
          Math.max(
            Math.abs(
              best.score
            ),
            0.1
          ),
          0,
          1
        )
      : 0.5;

  const confidence =
    clamp(
      clamp(
        (
          best.avgContinuity -
          0.20
        ) /
        0.65,
        0,
        1
      ) *
      0.35 +

      clamp(
        (
          best.weakestContinuity -
          0.05
        ) /
        0.50,
        0,
        1
      ) *
      0.25 +

      clamp(
        (
          best.weakestDirectionalStrength -
          0.75
        ) /
        1.8,
        0,
        1
      ) *
      0.20 +

      clamp(
        (
          best.cornerSupport -
          0.80
        ) /
        1.7,
        0,
        1
      ) *
      0.10 +

      separation *
      0.10,

      0,
      1
    );

  let status =
    'low_confidence';

  if (
    confidence >=
    0.70
  ) {
    status =
      'high_confidence';

  } else if (
    confidence >=
    0.42
  ) {
    status =
      'review_required';
  }

  return {
    role,

    detector:
      'outer_frame_v5_4',

    status,

    confidence_0_1:
      round2(
        confidence
      ),

    normalized: {
      x:
        best.x /
        width,

      y:
        best.y /
        height,

      width:
        best.width /
        width,

      height:
        best.height /
        height
    },

    aspect_ratio:
      round2(
        best.aspect
      ),

    area_ratio:
      round2(
        best.areaRatio
      )
  };
}

/* =========================================================
   FRAME GEOMETRY
========================================================= */

/*
  Image 2 still needs the actual artwork rather than its mockup frame.

  This crop worked correctly in the previous compare,
  so it is intentionally retained only for the Image 2 source.
*/
function referenceArtworkRectFromOuter(
  outer
) {
  const insetX =
    0.035;

  const insetY =
    0.040;

  return {
    x:
      outer.x +
      outer.width *
      insetX,

    y:
      outer.y +
      outer.height *
      insetY,

    width:
      outer.width *
      (
        1 -
        insetX *
        2
      ),

    height:
      outer.height *
      (
        1 -
        insetY *
        2
      )
  };
}

/*
  v5.4 destination:
  artwork fills essentially the complete detected Rank-1 frame area.

  It deliberately extends underneath the original frame ring.
*/
function heroArtworkFillRect(
  outer
) {
  const inset =
    HERO_ARTWORK_BLEED_INSET;

  return {
    x:
      outer.x +
      outer.width *
      inset,

    y:
      outer.y +
      outer.height *
      inset,

    width:
      outer.width *
      (
        1 -
        inset *
        2
      ),

    height:
      outer.height *
      (
        1 -
        inset *
        2
      )
  };
}

function rectDistance(
  a,
  b
) {
  if (
    !a ||
    !b
  ) {
    return Infinity;
  }

  return Math.max(
    Math.abs(
      a.x -
      b.x
    ),

    Math.abs(
      a.y -
      b.y
    ),

    Math.abs(
      a.width -
      b.width
    ),

    Math.abs(
      a.height -
      b.height
    )
  );
}

function rectToPixels(
  normalizedRect,
  width,
  height
) {
  const left =
    clamp(
      Math.round(
        normalizedRect.x *
        width
      ),
      0,
      width -
      1
    );

  const top =
    clamp(
      Math.round(
        normalizedRect.y *
        height
      ),
      0,
      height -
      1
    );

  const right =
    clamp(
      Math.round(
        (
          normalizedRect.x +
          normalizedRect.width
        ) *
        width
      ),
      left + 1,
      width
    );

  const bottom =
    clamp(
      Math.round(
        (
          normalizedRect.y +
          normalizedRect.height
        ) *
        height
      ),
      top + 1,
      height
    );

  return {
    left,
    top,

    width:
      right -
      left,

    height:
      bottom -
      top
  };
}

function coverCropFraction(
  sourceAspect,
  targetAspect
) {
  if (
    !Number.isFinite(
      sourceAspect
    ) ||
    !Number.isFinite(
      targetAspect
    ) ||
    sourceAspect <= 0 ||
    targetAspect <= 0
  ) {
    return 1;
  }

  if (
    sourceAspect >
    targetAspect
  ) {
    /*
      Source is wider.
      Cover crops left/right.
    */
    return (
      1 -
      targetAspect /
      sourceAspect
    );
  }

  /*
    Source is taller/narrower.
    Cover crops top/bottom.
  */
  return (
    1 -
    sourceAspect /
    targetAspect
  );
}

/* =========================================================
   DETECTOR OVERLAY
========================================================= */

function detectorInnerGuide(
  outer,
  role
) {
  if (
    role ===
    'image2'
  ) {
    return (
      referenceArtworkRectFromOuter(
        outer
      )
    );
  }

  return (
    heroArtworkFillRect(
      outer
    )
  );
}

async function makeDetectorOverlay(
  buffer,
  detection,
  label
) {
  const normalized =
    await sharp(
      buffer
    )
      .rotate()
      .removeAlpha()
      .toColourspace(
        'srgb'
      )
      .jpeg({
        quality:
          95
      })
      .toBuffer();

  const metadata =
    await sharp(
      normalized
    ).metadata();

  const width =
    metadata.width;

  const height =
    metadata.height;

  if (
    !width ||
    !height
  ) {
    throw new Error(
      'Could not read overlay image dimensions'
    );
  }

  const outer =
    detection.normalized;

  const inner =
    detectorInnerGuide(
      outer,
      detection.role
    );

  const ox =
    Math.round(
      outer.x *
      width
    );

  const oy =
    Math.round(
      outer.y *
      height
    );

  const ow =
    Math.round(
      outer.width *
      width
    );

  const oh =
    Math.round(
      outer.height *
      height
    );

  const ix =
    Math.round(
      inner.x *
      width
    );

  const iy =
    Math.round(
      inner.y *
      height
    );

  const iw =
    Math.round(
      inner.width *
      width
    );

  const ih =
    Math.round(
      inner.height *
      height
    );

  const strokeWidth =
    Math.max(
      5,
      Math.round(
        Math.min(
          width,
          height
        ) *
        0.007
      )
    );

  const innerStroke =
    Math.max(
      3,
      Math.round(
        strokeWidth *
        0.65
      )
    );

  const fontSize =
    Math.max(
      26,
      Math.round(
        width *
        0.026
      )
    );

  const svg =
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect
        x="${ox}"
        y="${oy}"
        width="${ow}"
        height="${oh}"
        fill="none"
        stroke="#00ff66"
        stroke-width="${strokeWidth}"
      />
      <rect
        x="${ix}"
        y="${iy}"
        width="${iw}"
        height="${ih}"
        fill="none"
        stroke="#00d9ff"
        stroke-width="${innerStroke}"
        stroke-dasharray="${innerStroke * 3} ${innerStroke * 2}"
      />
      <rect
        x="${ox}"
        y="${Math.max(0, oy - fontSize - 18)}"
        width="${Math.min(ow, Math.round(width * 0.82))}"
        height="${fontSize + 16}"
        fill="rgba(0,0,0,0.78)"
      />
      <text
        x="${ox + 8}"
        y="${Math.max(fontSize, oy - 10)}"
        fill="#00ff66"
        font-size="${fontSize}"
        font-family="Arial, sans-serif"
        font-weight="700"
      >
        ${label}
      </text>
    </svg>`;

  return sharp(
    normalized
  )
    .composite([
      {
        input:
          Buffer.from(
            svg
          ),

        top:
          0,

        left:
          0
      }
    ])
    .jpeg({
      quality:
        96,

      chromaSubsampling:
        '4:4:4'
    })
    .toBuffer();
}

/* =========================================================
   V5.4 COVER-FIT TRANSFER
========================================================= */

async function normalizeForComposite(
  buffer
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
        3000,

      height:
        3000,

      fit:
        'inside',

      withoutEnlargement:
        true
    })
    .png({
      compressionLevel:
        3
    })
    .toBuffer({
      resolveWithObject:
        true
    });
}

async function extractFrameRingLayers(
  heroBuffer,
  outerRect
) {
  const borderX =
    Math.max(
      4,
      Math.round(
        outerRect.width *
        FRAME_RING_X_RATIO
      )
    );

  const borderY =
    Math.max(
      4,
      Math.round(
        outerRect.height *
        FRAME_RING_Y_RATIO
      )
    );

  if (
    borderX * 2 >=
      outerRect.width ||
    borderY * 2 >=
      outerRect.height
  ) {
    const err =
      new Error(
        'frame_ring_geometry_invalid'
      );

    err.status = 422;
    throw err;
  }

  const top =
    await sharp(
      heroBuffer
    )
      .extract({
        left:
          outerRect.left,

        top:
          outerRect.top,

        width:
          outerRect.width,

        height:
          borderY
      })
      .png()
      .toBuffer();

  const bottom =
    await sharp(
      heroBuffer
    )
      .extract({
        left:
          outerRect.left,

        top:
          outerRect.top +
          outerRect.height -
          borderY,

        width:
          outerRect.width,

        height:
          borderY
      })
      .png()
      .toBuffer();

  const sideHeight =
    outerRect.height -
    borderY * 2;

  const left =
    await sharp(
      heroBuffer
    )
      .extract({
        left:
          outerRect.left,

        top:
          outerRect.top +
          borderY,

        width:
          borderX,

        height:
          sideHeight
      })
      .png()
      .toBuffer();

  const right =
    await sharp(
      heroBuffer
    )
      .extract({
        left:
          outerRect.left +
          outerRect.width -
          borderX,

        top:
          outerRect.top +
          borderY,

        width:
          borderX,

        height:
          sideHeight
      })
      .png()
      .toBuffer();

  return [
    {
      input:
        top,

      left:
        outerRect.left,

      top:
        outerRect.top
    },

    {
      input:
        bottom,

      left:
        outerRect.left,

      top:
        outerRect.top +
        outerRect.height -
        borderY
    },

    {
      input:
        left,

      left:
        outerRect.left,

      top:
        outerRect.top +
        borderY
    },

    {
      input:
        right,

      left:
        outerRect.left +
        outerRect.width -
        borderX,

      top:
        outerRect.top +
        borderY
    }
  ];
}

async function renderApprovedTransfer(
  heroBuffer,
  image2Buffer,
  heroOuter,
  image2Outer
) {
  const heroNorm =
    await normalizeForComposite(
      heroBuffer
    );

  const refNorm =
    await normalizeForComposite(
      image2Buffer
    );

  /*
    Image 2 source:
    use only its artwork area.
  */
  const refArtworkRect =
    referenceArtworkRectFromOuter(
      image2Outer
    );

  /*
    Rank 1 destination:
    fill almost the whole detected frame,
    underneath the original frame border.
  */
  const heroFillNormalized =
    heroArtworkFillRect(
      heroOuter
    );

  const heroOuterPixels =
    rectToPixels(
      heroOuter,
      heroNorm.info.width,
      heroNorm.info.height
    );

  const heroTarget =
    rectToPixels(
      heroFillNormalized,
      heroNorm.info.width,
      heroNorm.info.height
    );

  const refCrop =
    rectToPixels(
      refArtworkRect,
      refNorm.info.width,
      refNorm.info.height
    );

  if (
    heroTarget.width <
      120 ||
    heroTarget.height <
      120 ||
    refCrop.width <
      120 ||
    refCrop.height <
      120
  ) {
    const err =
      new Error(
        'approved_frame_region_too_small'
      );

    err.status = 422;
    throw err;
  }

  const sourceAspect =
    refCrop.width /
    refCrop.height;

  const targetAspect =
    heroTarget.width /
    heroTarget.height;

  const cropFraction =
    coverCropFraction(
      sourceAspect,
      targetAspect
    );

  if (
    cropFraction >
    COVER_CROP_HARD_LIMIT
  ) {
    const err =
      new Error(
        'cover_fit_would_crop_too_much_artwork'
      );

    err.status = 422;

    err.details = {
      source_aspect_ratio:
        round2(
          sourceAspect
        ),

      target_aspect_ratio:
        round2(
          targetAspect
        ),

      estimated_crop_percent:
        round1(
          cropFraction *
          100
        ),

      hard_limit_percent:
        round1(
          COVER_CROP_HARD_LIMIT *
          100
        ),

      reason:
        'Too much artwork would be removed by cover fitting.'
    };

    throw err;
  }

  const referenceArtwork =
    await sharp(
      refNorm.data
    )
      .extract(
        refCrop
      )
      .png()
      .toBuffer();

  /*
    IMPORTANT:
    fit: cover

    - no stretching
    - no letterbox
    - no empty strip
    - small center crop only if needed
  */
  const fittedArtwork =
    await sharp(
      referenceArtwork
    )
      .resize({
        width:
          heroTarget.width,

        height:
          heroTarget.height,

        fit:
          'cover',

        position:
          'centre',

        kernel:
          sharp.kernel.lanczos3
      })
      .png()
      .toBuffer();

  /*
    Preserve only the narrow physical frame edge from Rank 1.
    The transferred artwork extends underneath these strips,
    so old artwork cannot remain visible as a gap.
  */
  const frameRingLayers =
    await extractFrameRingLayers(
      heroNorm.data,
      heroOuterPixels
    );

  const composed =
    await sharp(
      heroNorm.data
    )
      .composite([
        {
          input:
            fittedArtwork,

          left:
            heroTarget.left,

          top:
            heroTarget.top,

          blend:
            'over'
        },

        ...frameRingLayers
      ])
      .jpeg({
        quality:
          95,

        chromaSubsampling:
          '4:4:4'
      })
      .toBuffer();

  if (
    composed.length >
    20 *
    1024 *
    1024
  ) {
    const err =
      new Error(
        'Generated preview is larger than 20 MB'
      );

    err.status = 413;
    throw err;
  }

  const warnings = [];

  if (
    cropFraction >
    COVER_CROP_WARNING
  ) {
    warnings.push(
      'cover_fit_uses_noticeable_center_crop'
    );
  }

  return {
    composed,

    refArtworkRect,
    heroFillNormalized,
    heroTarget,
    refCrop,

    safety: {
      passed:
        true,

      hard_block_upload:
        false,

      warnings,

      transfer_version:
        'v5.4',

      transfer_mode:
        'cover_fit_under_original_frame',

      source_aspect_ratio:
        round2(
          sourceAspect
        ),

      target_aspect_ratio:
        round2(
          targetAspect
        ),

      estimated_cover_crop_percent:
        round1(
          cropFraction *
          100
        ),

      stretch_used:
        false,

      letterbox_used:
        false,

      generative_redraw_used:
        false,

      image2_reference_pixels_reused:
        true,

      color_transform_applied:
        false,

      hero_room_changed:
        false,

      original_frame_ring_restored:
        true,

      perspective_warp_applied:
        false,

      note:
        'Image 2 artwork is cover-fitted beneath the original Rank 1 frame. No empty artwork strip is intentionally left.'
    }
  };
}

/* =========================================================
   TOKENS
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
      .update(
        encoded
      )
      .digest(
        'base64url'
      );

  return (
    `${encoded}.${signature}`
  );
}

function verifyToken(
  token,
  expectedTypes = null
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
      .update(
        encoded
      )
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
    expectedTypes
  ) {
    const allowed =
      Array.isArray(
        expectedTypes
      )
        ? expectedTypes
        : [
            expectedTypes
          ];

    if (
      !allowed.includes(
        payload.type
      )
    ) {
      const err =
        new Error(
          'Signed token is for a different action'
        );

      err.status = 409;
      throw err;
    }
  }

  return payload;
}

/* =========================================================
   DETECTOR PREVIEW
========================================================= */

async function buildDetectorPreview(
  listingId
) {
  const listing =
    await etsyRequest(
      `/listings/${listingId}`
    );

  const imageSet =
    await getListingImageSet(
      listingId
    );

  if (
    !imageSet
      .rank2
      ?.imageUrl
  ) {
    const err =
      new Error(
        'image2_reference_required'
      );

    err.status = 422;
    throw err;
  }

  const [
    heroDownload,
    image2Download
  ] =
    await Promise.all([
      downloadImage(
        imageSet
          .rank1
          .imageUrl
      ),

      downloadImage(
        imageSet
          .rank2
          .imageUrl
      )
    ]);

  const [
    heroDetection,
    image2Detection
  ] =
    await Promise.all([
      detectOuterFrame(
        heroDownload.buffer,
        'hero'
      ),

      detectOuterFrame(
        image2Download.buffer,
        'image2'
      )
    ]);

  const token =
    signToken({
      type:
        'thumbnail_detector_v54',

      listingId,

      sourceImageId:
        String(
          imageSet
            .rank1
            .imageId
        ),

      rank2ImageId:
        String(
          imageSet
            .rank2
            .imageId
        ),

      heroDetection: {
        role:
          heroDetection.role,

        status:
          heroDetection.status,

        confidence_0_1:
          heroDetection
            .confidence_0_1,

        normalized:
          heroDetection.normalized
      },

      image2Detection: {
        role:
          image2Detection.role,

        status:
          image2Detection.status,

        confidence_0_1:
          image2Detection
            .confidence_0_1,

        normalized:
          image2Detection
            .normalized
      },

      exp:
        Date.now() +
        DETECTOR_TTL_MS
    });

  return {
    listing,
    imageSet,
    heroDetection,
    image2Detection,
    token
  };
}

async function verifyCurrentImagesAgainstToken(
  listingId,
  payload
) {
  const imageSet =
    await getListingImageSet(
      listingId
    );

  if (
    String(
      imageSet
        .rank1
        .imageId
    ) !==
    String(
      payload
        .sourceImageId
    )
  ) {
    const err =
      new Error(
        'Current rank 1 image changed after preview was created'
      );

    err.status = 409;
    throw err;
  }

  if (
    !imageSet.rank2 ||
    String(
      imageSet
        .rank2
        .imageId
    ) !==
    String(
      payload
        .rank2ImageId
    )
  ) {
    const err =
      new Error(
        'Image 2 reference changed after preview was created'
      );

    err.status = 409;
    throw err;
  }

  return imageSet;
}

/* =========================================================
   FRAME APPROVAL → V5.4 COVER PREVIEW
========================================================= */

async function buildApprovedTransferPreview(
  listingId,
  detectorToken,
  approval
) {
  if (
    approval !==
    FRAME_APPROVAL
  ) {
    const err =
      new Error(
        `Exact approval text ${FRAME_APPROVAL} is required`
      );

    err.status = 400;
    throw err;
  }

  /*
    Accept previous v5.3 detector token because the user already
    visually approved those frame boxes.

    We intentionally do NOT accept v5.3 transfer preview tokens
    for publishing later.
  */
  const detectorPayload =
    verifyToken(
      detectorToken,
      [
        'thumbnail_detector_v53',
        'thumbnail_detector_v54'
      ]
    );

  if (
    String(
      detectorPayload.listingId
    ) !==
    listingId
  ) {
    const err =
      new Error(
        'Detector token belongs to another listing'
      );

    err.status = 409;
    throw err;
  }

  const imageSet =
    await verifyCurrentImagesAgainstToken(
      listingId,
      detectorPayload
    );

  const [
    heroDownload,
    image2Download
  ] =
    await Promise.all([
      downloadImage(
        imageSet
          .rank1
          .imageUrl
      ),

      downloadImage(
        imageSet
          .rank2
          .imageUrl
      )
    ]);

  /*
    Re-run detector before using previously approved coordinates.
  */
  const [
    heroNow,
    image2Now
  ] =
    await Promise.all([
      detectOuterFrame(
        heroDownload.buffer,
        'hero'
      ),

      detectOuterFrame(
        image2Download.buffer,
        'image2'
      )
    ]);

  if (
    rectDistance(
      heroNow.normalized,
      detectorPayload
        .heroDetection
        ?.normalized
    ) >
      0.025 ||
    rectDistance(
      image2Now.normalized,
      detectorPayload
        .image2Detection
        ?.normalized
    ) >
      0.025
  ) {
    const err =
      new Error(
        'Frame detection changed since human approval; create a new detector preview'
      );

    err.status = 409;
    throw err;
  }

  const heroConfidence =
    Number(
      detectorPayload
        .heroDetection
        ?.confidence_0_1 ??
      0
    );

  const image2Confidence =
    Number(
      detectorPayload
        .image2Detection
        ?.confidence_0_1 ??
      0
    );

  if (
    heroConfidence <
      MIN_MANUAL_FRAME_CONFIDENCE ||
    image2Confidence <
      MIN_MANUAL_FRAME_CONFIDENCE
  ) {
    const err =
      new Error(
        'Frame confidence is too low even for manual approval'
      );

    err.status = 422;
    throw err;
  }

  const transfer =
    await renderApprovedTransfer(
      heroDownload.buffer,
      image2Download.buffer,
      detectorPayload
        .heroDetection
        .normalized,
      detectorPayload
        .image2Detection
        .normalized
    );

  const listing =
    await etsyRequest(
      `/listings/${listingId}`
    );

  const transferToken =
    signToken({
      type:
        'thumbnail_transfer_preview_v54',

      listingId,

      sourceImageId:
        String(
          imageSet
            .rank1
            .imageId
        ),

      rank2ImageId:
        String(
          imageSet
            .rank2
            .imageId
        ),

      heroOuter:
        detectorPayload
          .heroDetection
          .normalized,

      image2Outer:
        detectorPayload
          .image2Detection
          .normalized,

      method:
        'cover_fit_under_original_frame_v54',

      exp:
        Date.now() +
        TRANSFER_PREVIEW_TTL_MS
    });

  return {
    listing,
    imageSet,
    transfer,
    transferToken
  };
}

async function rebuildTransferFromPayload(
  listingId,
  payload
) {
  const imageSet =
    await verifyCurrentImagesAgainstToken(
      listingId,
      payload
    );

  const [
    heroDownload,
    image2Download
  ] =
    await Promise.all([
      downloadImage(
        imageSet
          .rank1
          .imageUrl
      ),

      downloadImage(
        imageSet
          .rank2
          .imageUrl
      )
    ]);

  const transfer =
    await renderApprovedTransfer(
      heroDownload.buffer,
      image2Download.buffer,
      payload.heroOuter,
      payload.image2Outer
    );

  return {
    imageSet,
    transfer
  };
}

/* =========================================================
   PUBLIC DETECTOR / PREVIEW
========================================================= */

app.get(
  '/preview/thumbnail-repair/:token/hero-detection',
  async (
    req,
    res
  ) => {
    try {
      const payload =
        verifyToken(
          req.params.token,
          [
            'thumbnail_detector_v53',
            'thumbnail_detector_v54'
          ]
        );

      const listingId =
        asListingId(
          payload.listingId
        );

      const imageSet =
        await verifyCurrentImagesAgainstToken(
          listingId,
          payload
        );

      const {
        buffer
      } =
        await downloadImage(
          imageSet
            .rank1
            .imageUrl
        );

      const overlay =
        await makeDetectorOverlay(
          buffer,
          payload.heroDetection,
          `HERO FRAME ${payload.heroDetection.confidence_0_1}`
        );

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.send(
        overlay
      );

    } catch (err) {
      res
        .status(
          err.status ||
          400
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

app.get(
  '/preview/thumbnail-repair/:token/image2-detection',
  async (
    req,
    res
  ) => {
    try {
      const payload =
        verifyToken(
          req.params.token,
          [
            'thumbnail_detector_v53',
            'thumbnail_detector_v54'
          ]
        );

      const listingId =
        asListingId(
          payload.listingId
        );

      const imageSet =
        await verifyCurrentImagesAgainstToken(
          listingId,
          payload
        );

      const {
        buffer
      } =
        await downloadImage(
          imageSet
            .rank2
            .imageUrl
        );

      const overlay =
        await makeDetectorOverlay(
          buffer,
          payload.image2Detection,
          `IMAGE 2 FRAME ${payload.image2Detection.confidence_0_1}`
        );

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.send(
        overlay
      );

    } catch (err) {
      res
        .status(
          err.status ||
          400
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

app.get(
  '/preview/thumbnail-repair/:token',
  async (
    req,
    res
  ) => {
    try {
      /*
        IMPORTANT:
        Old flawed v5.3 transfer token is intentionally rejected.
      */
      const payload =
        verifyToken(
          req.params.token,
          'thumbnail_transfer_preview_v54'
        );

      const listingId =
        asListingId(
          payload.listingId
        );

      const rebuilt =
        await rebuildTransferFromPayload(
          listingId,
          payload
        );

      if (
        !rebuilt
          .transfer
          .safety
          .passed
      ) {
        return res
          .status(409)
          .json({
            error:
              'transfer_safety_failed',

            visual_consistency:
              rebuilt
                .transfer
                .safety
          });
      }

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.setHeader(
        'content-disposition',
        'inline; filename="thumbnail-cover-fit-v54.jpg"'
      );

      res.setHeader(
        'cache-control',
        'private, max-age=300'
      );

      res.send(
        rebuilt
          .transfer
          .composed
      );

    } catch (err) {
      res
        .status(
          err.status ||
          400
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
          [
            'thumbnail_detector_v53',
            'thumbnail_detector_v54',
            'thumbnail_transfer_preview_v54'
          ]
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
        await verifyCurrentImagesAgainstToken(
          listingId,
          payload
        );

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

      const token =
        encodeURIComponent(
          req.params.token
        );

      if (
        payload.type ===
        'thumbnail_transfer_preview_v54'
      ) {
        const previewUrl =
          `${publicBase()}/preview/thumbnail-repair/${token}`;

        return res
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
VAELONS Cover Fit v5.4
</title>

<style>

body {
  margin: 0;
  background: #111;
  color: #f4f4f4;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
}

main {
  max-width: 1550px;
  margin: 0 auto;
  padding: 24px;
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
}

.note {
  margin-top: 18px;
  padding: 15px;
  background: #191919;
  border-radius: 12px;
  line-height: 1.55;
}

.ok {
  color: #00ff66;
  font-weight: 700;
}

@media (
  max-width: 950px
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
Rank 1 ${esc(imageSet.rank1.imageId)}
·
Image 2 ${esc(imageSet.rank2.imageId)}
</p>

<div class="grid">

<div class="card">

<div class="label">
A — mevcut Rank 1
</div>

<img
  src="${esc(imageSet.rank1.imageUrl)}"
>

</div>

<div class="card">

<div class="label">
B — Image 2 artwork reference
</div>

<img
  src="${esc(imageSet.rank2.imageUrl)}"
>

</div>

<div class="card">

<div class="label">
C — v5.4 COVER-FIT preview
</div>

<img
  src="${esc(previewUrl)}"
>

</div>

</div>

<div class="note">

<span class="ok">
V5.4 PREVIEW ONLY
</span>

<br><br>

Image 2 artwork,
Rank 1 frame alanını tamamen dolduracak şekilde
<b>cover-fit</b>
ile yerleştirilir.

<br>

Esnetme yoktur.
Boş şerit bırakılmaz.
Gerekirse yalnızca küçük merkez crop yapılır.

<br><br>

Orijinal Rank 1 çerçevesinin dar dış kenarı,
artwork'ün üzerine tekrar bindirilir.

<br><br>

Bu sayfa Etsy'yi değiştirmez.

</div>

</main>

</body>

</html>
          `);
      }

      const heroOverlayUrl =
        `${publicBase()}/preview/thumbnail-repair/${token}/hero-detection`;

      const image2OverlayUrl =
        `${publicBase()}/preview/thumbnail-repair/${token}/image2-detection`;

      return res
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
VAELONS Frame Detector
</title>

<style>

body {
  margin: 0;
  background: #111;
  color: #f4f4f4;
  font-family:
    system-ui,
    -apple-system,
    sans-serif;
}

main {
  max-width: 1400px;
  margin: 0 auto;
  padding: 24px;
}

.grid {
  display: grid;
  grid-template-columns:
    repeat(
      2,
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
}

@media (
  max-width: 850px
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

<div class="grid">

<div class="card">

<div class="label">
RANK 1
</div>

<img
  src="${esc(heroOverlayUrl)}"
>

</div>

<div class="card">

<div class="label">
IMAGE 2
</div>

<img
  src="${esc(image2OverlayUrl)}"
>

</div>

</div>

</main>

</body>

</html>
        `);

    } catch (err) {
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
        'vaelons-etsy-seller-bridge',

      thumbnail_engine:
        'cover_fit_under_original_frame_v5_4',

      frame_approval_required:
        FRAME_APPROVAL,

      publish_approval_required:
        PUBLISH_APPROVAL,

      cleanup_approval_required:
        CLEANUP_APPROVAL
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
    if (
      req.query
        .setup_secret !==
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
              req.query
                .error
            }`
          );
      }

      const cookie =
        parseCookies(
          req
        ).etsy_oauth;

      if (!cookie) {
        return res
          .status(400)
          .send(
            'OAuth session expired. Start again.'
          );
      }

      const flow =
        openJson(
          cookie
        );

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
            limit:
              1,

            state:
              'active'
          }
        }
      );

      const encryptedCapsule =
        sealJson({
          refresh_token:
            token.refresh_token,

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

<h2>
VAELONS Etsy Seller bağlantısı doğrulandı.
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

    } catch (err) {
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
   API AUTH
========================================================= */

app.use(
  '/api',
  bridgeAuth
);

/* =========================================================
   CONNECTION / SHOP
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
      const allowed =
        [
          'title',
          'announcement',
          'sale_message',
          'digital_sale_message',
          'policy_additional'
        ];

      const body =
        Object.fromEntries(
          Object.entries(
            req.body || {}
          ).filter(
            (
              [key]
            ) =>
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
                listing.original_creation_timestamp ??
                listing.creation_timestamp ??
                listing.created_timestamp ??
                null,

              updated_timestamp:
                listing.updated_timestamp ??
                listing.last_modified_timestamp ??
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

      const allowed =
        [
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
            req.body || {}
          ).filter(
            (
              [key]
            ) =>
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
      res.json(
        await getListingImages(
          asListingId(
            req.params.listingId
          )
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

      if (
        imageBuffer.length >
        20 *
        1024 *
        1024
      ) {
        return res
          .status(413)
          .json({
            error:
              'Image is larger than 20 MB'
          });
      }

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

      res.json(
        await uploadListingImage({
          shopId:
            await sid(),

          listingId,

          imageBuffer,

          filename:
            fileRef.name ||
            'image.jpg',

          contentType
        })
      );

    } catch (err) {
      next(err);
    }
  }
);

/* =========================================================
   THUMBNAIL ANALYSIS
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
          imageSet
            .rank1
            .imageUrl
        );

      const analysis =
        await analyzeImage(
          buffer
        );

      res.json({
        listing_id:
          Number(
            listingId
          ),

        exact_title:
          listing?.title ??
          null,

        image_id:
          imageSet
            .rank1
            .imageId,

        rank:
          imageSet
            .rank1
            .image
            .rank ??
          null,

        image_url:
          imageSet
            .rank1
            .imageUrl,

        image2_reference_id:
          imageSet
            .rank2
            ?.imageId ??
          null,

        image2_reference_url:
          imageSet
            .rank2
            ?.imageUrl ??
          null,

        analysis,

        assessment:
          assessThumbnail(
            analysis
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
   WORKER
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
      () =>
        worker()
    )
  );

  return results;
}

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
                  imageSet
                    .rank1
                    .imageUrl
                );

              const analysis =
                await analyzeImage(
                  buffer
                );

              return {
                listing_id:
                  listing.listing_id,

                exact_title:
                  listing.title,

                rank1_image_id:
                  imageSet
                    .rank1
                    .imageId,

                rank1_image_url:
                  imageSet
                    .rank1
                    .imageUrl,

                image2_reference_id:
                  imageSet
                    .rank2
                    ?.imageId ??
                  null,

                image2_reference_url:
                  imageSet
                    .rank2
                    ?.imageUrl ??
                  null,

                analysis,

                assessment:
                  assessThumbnail(
                    analysis
                  )
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
   PREVIEW
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

      const frameApproval =
        String(
          req.body
            ?.frame_approval ||
          ''
        ).trim();

      const detectorToken =
        String(
          req.body
            ?.detector_token ||
          ''
        ).trim();

      /*
        STAGE 1
        Detector only.
      */
      if (
        !frameApproval &&
        !detectorToken
      ) {
        const preview =
          await buildDetectorPreview(
            listingId
          );

        return res.json({
          stage:
            'frame_detection',

          listing_id:
            Number(
              listingId
            ),

          exact_title:
            preview
              .listing
              ?.title ??
            null,

          source_image_id:
            preview
              .imageSet
              .rank1
              .imageId,

          source_image_url:
            preview
              .imageSet
              .rank1
              .imageUrl,

          image2_reference_id:
            preview
              .imageSet
              .rank2
              .imageId,

          image2_reference_url:
            preview
              .imageSet
              .rank2
              .imageUrl,

          hero_frame:
            preview
              .heroDetection,

          image2_frame:
            preview
              .image2Detection,

          compare_url:
            `${publicBase()}/preview/thumbnail-repair/${preview.token}/compare`,

          detector_token:
            preview.token,

          next_required_approval:
            FRAME_APPROVAL,

          artwork_transfer_performed:
            false,

          upload_blocked_by_consistency:
            true,

          etsy_modified:
            false
        });
      }

      /*
        STAGE 2
        Human-approved frame → cover-fit preview.
      */
      if (
        frameApproval !==
        FRAME_APPROVAL
      ) {
        return res
          .status(400)
          .json({
            error:
              `Exact approval text ${FRAME_APPROVAL} is required`,

            etsy_modified:
              false
          });
      }

      if (!detectorToken) {
        return res
          .status(400)
          .json({
            error:
              'detector_token is required with frame approval',

            etsy_modified:
              false
          });
      }

      const preview =
        await buildApprovedTransferPreview(
          listingId,
          detectorToken,
          frameApproval
        );

      return res.json({
        stage:
          'artwork_transfer_preview',

        listing_id:
          Number(
            listingId
          ),

        exact_title:
          preview
            .listing
            ?.title ??
          null,

        source_image_id:
          preview
            .imageSet
            .rank1
            .imageId,

        image2_reference_id:
          preview
            .imageSet
            .rank2
            .imageId,

        artwork_transfer_performed:
          true,

        transfer_method:
          'cover_fit_under_original_frame_v54',

        visual_consistency:
          preview
            .transfer
            .safety,

        preview_url:
          `${publicBase()}/preview/thumbnail-repair/${preview.transferToken}`,

        compare_url:
          `${publicBase()}/preview/thumbnail-repair/${preview.transferToken}/compare`,

        preview_token:
          preview
            .transferToken,

        approval_required_for_upload:
          PUBLISH_APPROVAL,

        upload_blocked_by_consistency:
          !preview
            .transfer
            .safety
            .passed,

        existing_images_deleted:
          false,

        listing_fields_changed:
          false,

        etsy_modified:
          false
      });

    } catch (err) {
      next(err);
    }
  }
);

/* =========================================================
   APPLY
========================================================= */

app.post(
  '/api/listings/:listingId/thumbnail-repair/apply',
  async (
    req,
    res,
    next
  ) => {
    let uploadOccurred =
      false;

    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const approval =
        String(
          req.body
            ?.approval ||
          ''
        ).trim();

      const previewToken =
        String(
          req.body
            ?.preview_token ||
          ''
        ).trim();

      if (
        approval !==
        PUBLISH_APPROVAL
      ) {
        return res
          .status(400)
          .json({
            error:
              `Exact approval text ${PUBLISH_APPROVAL} is required`,

            etsy_modified:
              false
          });
      }

      /*
        SECURITY:
        old v5.3 transfer previews cannot be published.
      */
      const payload =
        verifyToken(
          previewToken,
          'thumbnail_transfer_preview_v54'
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
              'Preview token belongs to another listing',

            etsy_modified:
              false
          });
      }

      const listing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const rebuilt =
        await rebuildTransferFromPayload(
          listingId,
          payload
        );

      if (
        !rebuilt
          .transfer
          .safety
          .passed
      ) {
        return res
          .status(409)
          .json({
            error:
              'Transfer safety check failed before upload',

            visual_consistency:
              rebuilt
                .transfer
                .safety,

            etsy_modified:
              false
          });
      }

      const beforeIds =
        new Set(
          rebuilt
            .imageSet
            .images
            .map(
              (img) =>
                String(
                  getImageId(
                    img
                  )
                )
            )
            .filter(Boolean)
        );

      const uploadResult =
        await uploadListingImage({
          shopId:
            await sid(),

          listingId,

          imageBuffer:
            rebuilt
              .transfer
              .composed,

          filename:
            `etsy-${listingId}-cover-fit-v54.jpg`,

          contentType:
            'image/jpeg'
        });

      uploadOccurred = true;

      const uploadedRecord =
        extractUploadedImage(
          uploadResult
        );

      let uploadedImageId =
        getImageId(
          uploadedRecord
        );

      const postImagesData =
        await getListingImages(
          listingId
        );

      const postImages =
        postImagesData
          ?.results ||
        [];

      const newlyAddedImages =
        postImages.filter(
          (img) => {
            const id =
              getImageId(
                img
              );

            return (
              id != null &&
              !beforeIds.has(
                String(id)
              )
            );
          }
        );

      if (
        !uploadedImageId &&
        newlyAddedImages.length ===
          1
      ) {
        uploadedImageId =
          getImageId(
            newlyAddedImages[0]
          );
      }

      const concurrentImageChangeDetected =
        newlyAddedImages.length >
        1;

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
                  getImageId(
                    img
                  )
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

      let cleanupToken = null;

      if (
        newImageExists &&
        newImageIsRank1 &&
        !concurrentImageChangeDetected
      ) {
        cleanupToken =
          signToken({
            type:
              'thumbnail_cleanup_v1',

            listingId,

            sourceImageId:
              String(
                rebuilt
                  .imageSet
                  .rank1
                  .imageId
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
            newImageIsRank1 &&
            !concurrentImageChangeDetected
          ),

        exact_title:
          listing?.title ??
          null,

        listing_id:
          Number(
            listingId
          ),

        source_image_id:
          rebuilt
            .imageSet
            .rank1
            .imageId,

        image2_reference_id:
          rebuilt
            .imageSet
            .rank2
            .imageId,

        uploaded_image_id:
          uploadedImageId,

        current_rank1_image_id:
          currentRank1Id,

        replacement_verified_as_rank1:
          newImageIsRank1,

        concurrent_image_change_detected:
          concurrentImageChangeDetected,

        visual_consistency:
          rebuilt
            .transfer
            .safety,

        existing_images_deleted:
          false,

        listing_fields_changed:
          false,

        etsy_modified:
          true,

        cleanup_available:
          Boolean(
            cleanupToken
          ),

        cleanup_token:
          cleanupToken,

        cleanup_requires_exact_approval:
          cleanupToken
            ? CLEANUP_APPROVAL
            : null
      });

    } catch (err) {
      if (
        uploadOccurred
      ) {
        err.etsyModified =
          true;
      }

      next(err);
    }
  }
);

/* =========================================================
   CLEANUP
========================================================= */

app.post(
  '/api/listings/:listingId/thumbnail-repair/cleanup',
  async (
    req,
    res,
    next
  ) => {
    let deletionOccurred =
      false;

    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const approval =
        String(
          req.body
            ?.approval ||
          ''
        ).trim();

      const cleanupToken =
        String(
          req.body
            ?.cleanup_token ||
          ''
        ).trim();

      if (
        approval !==
        CLEANUP_APPROVAL
      ) {
        return res
          .status(400)
          .json({
            error:
              `Exact approval text ${CLEANUP_APPROVAL} is required`,

            etsy_modified:
              false
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
              'Cleanup token belongs to another listing',

            etsy_modified:
              false
          });
      }

      const beforeData =
        await getListingImages(
          listingId
        );

      const images =
        beforeData
          ?.results ||
        [];

      if (
        images.length <
        2
      ) {
        return res
          .status(409)
          .json({
            error:
              'Cleanup blocked because listing has fewer than two images',

            etsy_modified:
              false
          });
      }

      const source =
        images.find(
          (img) =>
            String(
              getImageId(
                img
              )
            ) ===
            String(
              payload
                .sourceImageId
            )
        );

      const replacement =
        images.find(
          (img) =>
            String(
              getImageId(
                img
              )
            ) ===
            String(
              payload
                .replacementImageId
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
              'Old source image is no longer attached',

            etsy_modified:
              false
          });
      }

      if (!replacement) {
        return res
          .status(409)
          .json({
            error:
              'Replacement image is missing',

            etsy_modified:
              false
          });
      }

      if (
        String(
          getImageId(
            rank1
          )
        ) !==
        String(
          payload
            .replacementImageId
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Replacement is not current rank 1; cleanup blocked',

            etsy_modified:
              false
          });
      }

      const variationData =
        await etsyRequest(
          `/shops/${await sid()}/listings/${listingId}/variation-images`
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
              item?.image_id
            ) ===
            String(
              payload
                .sourceImageId
            )
        );

      if (
        usedByVariation
      ) {
        return res
          .status(409)
          .json({
            error:
              'Old source image is used by a variation; cleanup blocked',

            etsy_modified:
              false
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

        deletionOccurred = true;

      } catch (deleteErr) {
        const probe =
          await getListingImages(
            listingId
          ).catch(
            () =>
              null
          );

        const stillExists =
          (
            probe?.results ||
            []
          ).some(
            (img) =>
              String(
                getImageId(
                  img
                )
              ) ===
              String(
                payload
                  .sourceImageId
              )
          );

        if (
          !probe ||
          stillExists
        ) {
          throw deleteErr;
        }

        deletionOccurred = true;
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
              getImageId(
                img
              )
            ) ===
            String(
              payload
                .sourceImageId
            )
        );

      const replacementAfter =
        afterImages.find(
          (img) =>
            String(
              getImageId(
                img
              )
            ) ===
            String(
              payload
                .replacementImageId
            )
        );

      res.json({
        success:
          Boolean(
            !sourceStillExists &&
            Number(
              replacementAfter
                ?.rank
            ) ===
            1
          ),

        listing_id:
          Number(
            listingId
          ),

        deleted_old_source_image_id:
          payload
            .sourceImageId,

        replacement_image_id:
          payload
            .replacementImageId,

        replacement_rank_after_cleanup:
          replacementAfter
            ?.rank ??
          null,

        old_source_still_present:
          sourceStillExists,

        listing_fields_changed:
          false,

        etsy_modified:
          deletionOccurred
      });

    } catch (err) {
      if (
        deletionOccurred
      ) {
        err.etsyModified =
          true;
      }

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
          req.body
            ?.title ||
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
          req.body
            ?.title ||
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
    console.error(
      err
    );

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
          null,

        etsy_modified:
          err.etsyModified ===
          true
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
