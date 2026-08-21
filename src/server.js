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

  if (
    !rank1Url
  ) {
    const err =
      new Error(
        'No usable rank 1 image URL found'
      );

    err.status =
      404;

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

    err.status =
      400;

    throw err;
  }

  const response =
    await fetch(url);

  if (
    !response.ok
  ) {
    const err =
      new Error(
        `Could not download image (${response.status})`
      );

    err.status =
      502;

    throw err;
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
  if (
    !values.length
  ) {
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

  const values =
    [];

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

    values.push(
      y
    );

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

    if (
      y < 55
    ) {
      shadowCount +=
        1;
    }

    if (
      y < 28
    ) {
      deepShadowCount +=
        1;
    }

    if (
      y > 230
    ) {
      highlightCount +=
        1;
    }

    count +=
      1;
  }

  values.sort(
    (
      a,
      b
    ) =>
      a - b
  );

  const safeCount =
    count ||
    1;

  const brightness =
    Math.round(
      sumL /
      safeCount
    );

  let variance =
    0;

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
  let score =
    100;

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

  if (
    b < 50
  ) {
    score -=
      34;

  } else if (
    b < 60
  ) {
    score -=
      27;

  } else if (
    b < 70
  ) {
    score -=
      19;

  } else if (
    b < 80
  ) {
    score -=
      11;

  } else if (
    b < 90
  ) {
    score -=
      5;
  }

  if (
    shadows > 60
  ) {
    score -=
      24;

  } else if (
    shadows > 50
  ) {
    score -=
      17;

  } else if (
    shadows > 40
  ) {
    score -=
      10;

  } else if (
    shadows > 32
  ) {
    score -=
      5;
  }

  if (
    deep > 38
  ) {
    score -=
      14;

  } else if (
    deep > 28
  ) {
    score -=
      9;

  } else if (
    deep > 20
  ) {
    score -=
      4;
  }

  if (
    highlights > 14
  ) {
    score -=
      8;

  } else if (
    highlights > 8
  ) {
    score -=
      4;
  }

  if (
    range < 55
  ) {
    score -=
      12;

  } else if (
    range < 70
  ) {
    score -=
      6;
  }

  score =
    clamp(
      Math.round(
        score
      ),
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
   V5.2 OUTER FRAME DETECTOR

   Changes:
   - horizontal and vertical edges scored separately
   - all four borders must be continuous
   - larger outer rectangles preferred
   - corner support required
   - avoids confusing artwork details with frame borders
   - detector-only, no transfer and no Etsy modification
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
    let rowSum =
      0;

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
    stride
  };
}

function rectSum(
  integral,
  stride,
  x,
  y,
  width,
  height
) {
  const x1 =
    Math.max(
      0,
      Math.round(
        x
      )
    );

  const y1 =
    Math.max(
      0,
      Math.round(
        y
      )
    );

  const x2 =
    Math.max(
      x1 + 1,
      Math.round(
        x +
        width
      )
    );

  const y2 =
    Math.max(
      y1 + 1,
      Math.round(
        y +
        height
      )
    );

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
  integral,
  stride,
  x,
  y,
  width,
  height
) {
  const w =
    Math.max(
      1,
      Math.round(
        width
      )
    );

  const h =
    Math.max(
      1,
      Math.round(
        height
      )
    );

  return (
    rectSum(
      integral,
      stride,
      x,
      y,
      w,
      h
    ) /
    (
      w *
      h
    )
  );
}

function generateFractions(
  start,
  end,
  step
) {
  const values =
    [];

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
        value.toFixed(
          4
        )
      )
    );
  }

  return values;
}

function segmentMeansHorizontal(
  integral,
  stride,
  x,
  y,
  width,
  strip,
  segments = 9
) {
  const means =
    [];

  const segmentWidth =
    width /
    segments;

  for (
    let i = 0;
    i < segments;
    i += 1
  ) {
    const sx =
      x +
      i *
      segmentWidth;

    means.push(
      rectMean(
        integral,
        stride,
        sx,
        y,
        segmentWidth,
        strip
      )
    );
  }

  return means;
}

function segmentMeansVertical(
  integral,
  stride,
  x,
  y,
  strip,
  height,
  segments = 9
) {
  const means =
    [];

  const segmentHeight =
    height /
    segments;

  for (
    let i = 0;
    i < segments;
    i += 1
  ) {
    const sy =
      y +
      i *
      segmentHeight;

    means.push(
      rectMean(
        integral,
        stride,
        x,
        sy,
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
  if (
    !values.length
  ) {
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
    p25,
    median,
    strongSegments,

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
          1.0
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
      maps
        .horizontal
        .integral,

      maps
        .horizontal
        .stride,

      x,
      y,
      width,
      strip
    );

  const bottomSegments =
    segmentMeansHorizontal(
      maps
        .horizontal
        .integral,

      maps
        .horizontal
        .stride,

      x,

      y +
      height -
      strip,

      width,
      strip
    );

  const leftSegments =
    segmentMeansVertical(
      maps
        .vertical
        .integral,

      maps
        .vertical
        .stride,

      x,
      y,
      strip,
      height
    );

  const rightSegments =
    segmentMeansVertical(
      maps
        .vertical
        .integral,

      maps
        .vertical
        .stride,

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
      maps
        .horizontalMean
    );

  const bottomCont =
    continuityScore(
      bottomSegments,
      maps
        .horizontalMean
    );

  const leftCont =
    continuityScore(
      leftSegments,
      maps
        .verticalMean
    );

  const rightCont =
    continuityScore(
      rightSegments,
      maps
        .verticalMean
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
        maps.total.integral,
        maps.total.stride,
        x,
        y,
        cornerSize,
        cornerSize
      ),

      rectMean(
        maps.total.integral,
        maps.total.stride,
        x +
        width -
        cornerSize,
        y,
        cornerSize,
        cornerSize
      ),

      rectMean(
        maps.total.integral,
        maps.total.stride,
        x,
        y +
        height -
        cornerSize,
        cornerSize,
        cornerSize
      ),

      rectMean(
        maps.total.integral,
        maps.total.stride,
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

  const cornerRatios =
    cornerMeans.map(
      (value) =>
        value /
        Math.max(
          maps.totalMean,
          0.001
        )
    );

  const cornerSupport =
    percentile(
      cornerRatios,
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
      maps.total.integral,
      maps.total.stride,
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
    (
      width *
      height
    ) /
    (
      maps.width *
      maps.height
    );

  const centerX =
    (
      x +
      width /
      2
    ) /
    maps.width;

  const centerY =
    (
      y +
      height /
      2
    ) /
    maps.height;

  const targetCenterY =
    role ===
    'hero'
      ? 0.47
      : 0.47;

  const centerPenalty =
    Math.abs(
      centerX -
      0.5
    ) *
    1.35 +
    Math.abs(
      centerY -
      targetCenterY
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

  const horizontalReach =
    clamp(
      width /
      maps.width,
      0,
      1
    );

  const verticalReach =
    clamp(
      height /
      maps.height,
      0,
      1
    );

  const reachBonus =
    clamp(
      (
        (
          horizontalReach +
          verticalReach
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

    centerX,
    centerY,

    avgContinuity,
    weakestContinuity,
    horizontalStrength,
    verticalStrength,
    weakestDirectionalStrength,
    cornerSupport,
    borderVsInside,
    outerSizeBonus,
    reachBonus
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

async function detectOuterFrameV52(
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
        gx +
        gy;

      verticalSum +=
        gx;

      horizontalSum +=
        gy;

      totalSum +=
        gx +
        gy;

      edgeCount +=
        1;
    }
  }

  const verticalMean =
    verticalSum /
    Math.max(
      edgeCount,
      1
    );

  const horizontalMean =
    horizontalSum /
    Math.max(
      edgeCount,
      1
    );

  const totalMean =
    totalSum /
    Math.max(
      edgeCount,
      1
    );

  const vertical =
    buildIntegralImage(
      verticalEdges,
      width,
      height
    );

  const horizontal =
    buildIntegralImage(
      horizontalEdges,
      width,
      height
    );

  const total =
    buildIntegralImage(
      totalEdges,
      width,
      height
    );

  const maps = {
    width,
    height,
    vertical,
    horizontal,
    total,
    verticalMean,
    horizontalMean,
    totalMean
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

  const candidates =
    [];

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
            0.24
          ) {
            continue;
          }

          if (
            metrics
              .weakestContinuity <
            0.08
          ) {
            continue;
          }

          if (
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

  if (
    !candidates.length
  ) {
    const err =
      new Error(
        'outer_frame_detector_found_no_candidate'
      );

    err.status =
      422;

    err.details = {
      role,

      reason:
        'No sufficiently continuous four-sided outer frame candidate was found.'
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
    candidates.filter(
      (candidate) =>
        candidate.score >=
        bestScore -
        0.24
    );

  nearBest.sort(
    (
      a,
      b
    ) => {
      if (
        Math.abs(
          b.areaRatio -
          a.areaRatio
        ) >
        0.015
      ) {
        return (
          b.areaRatio -
          a.areaRatio
        );
      }

      return (
        b.score -
        a.score
      );
    }
  );

  const best =
    nearBest[0];

  let second =
    null;

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
      second =
        candidate;

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

  const continuityConfidence =
    clamp(
      (
        best.avgContinuity -
        0.20
      ) /
      0.65,
      0,
      1
    );

  const weakestConfidence =
    clamp(
      (
        best.weakestContinuity -
        0.05
      ) /
      0.50,
      0,
      1
    );

  const directionalConfidence =
    clamp(
      (
        best.weakestDirectionalStrength -
        0.75
      ) /
      1.8,
      0,
      1
    );

  const cornerConfidence =
    clamp(
      (
        best.cornerSupport -
        0.80
      ) /
      1.7,
      0,
      1
    );

  const confidence =
    clamp(
      continuityConfidence *
      0.35 +

      weakestConfidence *
      0.25 +

      directionalConfidence *
      0.20 +

      cornerConfidence *
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
      'outer_frame_v5_2',

    status,

    confidence:
      round1(
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
      round1(
        best.aspect
      ),

    area_ratio:
      round1(
        best.areaRatio
      ),

    detector_metrics: {
      average_border_continuity:
        round1(
          best.avgContinuity
        ),

      weakest_border_continuity:
        round1(
          best.weakestContinuity
        ),

      horizontal_edge_strength:
        round1(
          best.horizontalStrength
        ),

      vertical_edge_strength:
        round1(
          best.verticalStrength
        ),

      weakest_directional_strength:
        round1(
          best.weakestDirectionalStrength
        ),

      corner_support:
        round1(
          best.cornerSupport
        ),

      border_to_inside_ratio:
        round1(
          best.borderVsInside
        ),

      candidate_separation:
        round1(
          separation
        ),

      outer_size_bonus:
        round1(
          best.outerSizeBonus
        ),

      reach_bonus:
        round1(
          best.reachBonus
        )
    },

    note:
      'V5.2 intentionally searches for the full outer frame and prefers larger continuous rectangles over inner artwork edges.'
  };
}

/* =========================================================
   OVERLAY
========================================================= */

function safeInnerRectFromOuter(
  outer,
  role
) {
  const insetX =
    role ===
    'hero'
      ? 0.045
      : 0.035;

  const insetY =
    role ===
    'hero'
      ? 0.055
      : 0.040;

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
    detection
      .normalized;

  const inner =
    safeInnerRectFromOuter(
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

  const svg = `
<svg
  width="${width}"
  height="${height}"
  xmlns="http://www.w3.org/2000/svg"
>

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
  y="${Math.max(
    0,
    oy -
    fontSize -
    18
  )}"
  width="${Math.min(
    ow,
    Math.round(
      width *
      0.82
    )
  )}"
  height="${fontSize + 16}"
  fill="rgba(0,0,0,0.78)"
/>

<text
  x="${ox + 8}"
  y="${Math.max(
    fontSize,
    oy - 10
  )}"
  fill="#00ff66"
  font-size="${fontSize}"
  font-family="Arial, sans-serif"
  font-weight="700"
>
${label}
</text>

</svg>
`;

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

    err.status =
      400;

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

    err.status =
      400;

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

    err.status =
      400;

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

    err.status =
      410;

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

    err.status =
      409;

    throw err;
  }

  return payload;
}

/* =========================================================
   BUILD DETECTOR PREVIEW
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

    err.status =
      422;

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
    image2Detection,
    heroAnalysis,
    image2Analysis
  ] =
    await Promise.all([
      detectOuterFrameV52(
        heroDownload.buffer,
        'hero'
      ),

      detectOuterFrameV52(
        image2Download.buffer,
        'image2'
      ),

      analyzeImage(
        heroDownload.buffer
      ),

      analyzeImage(
        image2Download.buffer
      )
    ]);

  const token =
    signToken({
      type:
        'thumbnail_detector_v52',

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

      heroDetection:
        heroDetection
          .normalized,

      image2Detection:
        image2Detection
          .normalized,

      exp:
        Date.now() +
        PREVIEW_TTL_MS
    });

  return {
    listing,
    imageSet,

    heroBuffer:
      heroDownload
        .buffer,

    image2Buffer:
      image2Download
        .buffer,

    heroDetection,
    image2Detection,
    heroAnalysis,
    image2Analysis,
    token
  };
}

/* =========================================================
   PUBLIC DETECTOR OVERLAYS
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
          'thumbnail_detector_v52'
        );

      const listingId =
        asListingId(
          payload
            .listingId
        );

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
        return res
          .status(409)
          .send(
            'Rank 1 changed after detector preview.'
          );
      }

      const {
        buffer
      } =
        await downloadImage(
          imageSet
            .rank1
            .imageUrl
        );

      const detection =
        await detectOuterFrameV52(
          buffer,
          'hero'
        );

      const overlay =
        await makeDetectorOverlay(
          buffer,
          detection,
          `HERO OUTER FRAME ${detection.confidence}`
        );

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.send(
        overlay
      );

    } catch (err) {
      console.error(
        err
      );

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
          'thumbnail_detector_v52'
        );

      const listingId =
        asListingId(
          payload
            .listingId
        );

      const imageSet =
        await getListingImageSet(
          listingId
        );

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
        return res
          .status(409)
          .send(
            'Image 2 changed after detector preview.'
          );
      }

      const {
        buffer
      } =
        await downloadImage(
          imageSet
            .rank2
            .imageUrl
        );

      const detection =
        await detectOuterFrameV52(
          buffer,
          'image2'
        );

      const overlay =
        await makeDetectorOverlay(
          buffer,
          detection,
          `IMAGE 2 OUTER FRAME ${detection.confidence}`
        );

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.send(
        overlay
      );

    } catch (err) {
      console.error(
        err
      );

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

/* =========================================================
   PUBLIC COMPARE
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
          'thumbnail_detector_v52'
        );

      const listingId =
        asListingId(
          payload
            .listingId
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
          imageSet
            .rank1
            .imageId
        ) !==
        String(
          payload
            .sourceImageId
        )
      ) {
        return res
          .status(409)
          .send(
            'Rank 1 changed after detector preview.'
          );
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
        return res
          .status(409)
          .send(
            'Image 2 changed after detector preview.'
          );
      }

      const token =
        encodeURIComponent(
          req.params.token
        );

      const heroOverlayUrl =
        `${publicBase()}/preview/thumbnail-repair/${token}/hero-detection`;

      const image2OverlayUrl =
        `${publicBase()}/preview/thumbnail-repair/${token}/image2-detection`;

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

      res
        .type(
          'html'
        )
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
VAELONS Outer Frame Detector v5.2
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

h1 {
  font-size: 21px;
  margin: 0 0 8px;
}

.sub {
  color: #bbb;
  margin-bottom: 20px;
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

.note {
  margin-top: 18px;
  padding: 15px;
  background: #191919;
  border-radius: 12px;
  line-height: 1.55;
}

.green {
  color: #00ff66;
  font-weight: 700;
}

.cyan {
  color: #00d9ff;
  font-weight: 700;
}

.warning {
  color: #ffd369;
  font-weight: 700;
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

<div class="sub">
Listing ${esc(listingId)}
· Rank 1 ${esc(imageSet.rank1.imageId)}
· Image 2 ${esc(imageSet.rank2.imageId)}
</div>

<div class="grid">

<div class="card">

<div class="label">
RANK 1 — tam dış çerçeve tespiti
</div>

<img
  src="${esc(heroOverlayUrl)}"
  alt="Hero outer frame detection"
>

</div>

<div class="card">

<div class="label">
IMAGE 2 — tam dış çerçeve tespiti
</div>

<img
  src="${esc(image2OverlayUrl)}"
  alt="Image 2 outer frame detection"
>

</div>

</div>

<div class="note">

<span class="warning">
DETECTOR-ONLY V5.2
</span>

<br><br>

<span class="green">
Yeşil kutu
</span>
tam dış çerçeveyi bulmaya çalışır.

Özellikle Rank 1'de üst ve alt çerçeveyi kesmemeli;
Image 2'de de sağdaki waterfall kısmını dışarıda bırakmamalıdır.

<br><br>

<span class="cyan">
Mavi kesikli kutu
</span>
yalnızca ileride kullanılabilecek güvenli iç artwork alanı için görsel yardımcıdır.
Şu anda transferde kullanılmaz.

<br><br>

Bu sürüm artwork değiştirmez,
görsel yayınlamaz
ve Etsy'ye hiçbir şey yüklemez.

</div>

</main>

</body>

</html>
        `);

    } catch (err) {
      console.error(
        err
      );

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
        'outer_frame_detector_only_v5_2',

      publishing_enabled:
        false
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

      if (
        !cookie
      ) {
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
Aşağıdaki şifreli değeri
<b>ETSY_TOKEN_CAPSULE</b>
olarak Vercel Environment Variables bölümüne ekleyin.
</p>

<textarea
  readonly
  onclick="this.select()"
>${encryptedCapsule}</textarea>
        `);

    } catch (err) {
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
      next(
        err
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
          `/shops/${await sid()}`
        )
      );

    } catch (err) {
      next(
        err
      );
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
            req.body ||
            {}
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
      next(
        err
      );
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
              req.query
                .limit ||
              25
            ),
            25
          )
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
        req.query
          .state ||
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
                listing
                  .listing_id,

              title:
                listing
                  .title,

              state:
                listing
                  .state,

              num_favorers:
                listing
                  .num_favorers ??
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
      next(
        err
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

    } catch (err) {
      next(
        err
      );
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
          req.params
            .listingId
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
            req.body ||
            {}
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
      next(
        err
      );
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
          req.params
            .listingId
        );

      res.json(
        await getListingImages(
          listingId
        )
      );

    } catch (err) {
      next(
        err
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
    try {
      const listingId =
        asListingId(
          req.params
            .listingId
        );

      const refs =
        req.body
          ?.openaiFileIdRefs;

      if (
        !Array.isArray(
          refs
        ) ||
        refs.length !==
          1
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
          fileRef
            .download_link
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
          fileRef
            .download_link
        );

      if (
        !response.ok
      ) {
        return res
          .status(400)
          .json({
            error:
              `Could not download image (${response.status})`
          });
      }

      const imageBuffer =
        Buffer.from(
          await response
            .arrayBuffer()
        );

      const contentType =
        fileRef
          .mime_type ||
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
            fileRef
              .name ||
            'image.jpg',

          contentType
        })
      );

    } catch (err) {
      next(
        err
      );
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
          req.params
            .listingId
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
          listing
            ?.title ??
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
      next(
        err
      );
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

  let cursor =
    0;

  async function worker() {
    while (
      true
    ) {
      const index =
        cursor;

      cursor +=
        1;

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
            req.query
              .offset ||
            0
          )
        );

      const limit =
        Math.max(
          1,
          Math.min(
            Number(
              req.query
                .limit ||
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
                  listing
                    .listing_id
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
                  listing
                    .listing_id,

                exact_title:
                  listing
                    .title,

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
                  listing
                    .listing_id,

                exact_title:
                  listing
                    .title,

                error:
                  err.message
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
      next(
        err
      );
    }
  }
);

/* =========================================================
   DETECTOR PREVIEW V5.2
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
          req.params
            .listingId
        );

      const preview =
        await buildDetectorPreview(
          listingId
        );

      const bothHigh =
        preview
          .heroDetection
          .status ===
          'high_confidence' &&
        preview
          .image2Detection
          .status ===
          'high_confidence';

      res.json({
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

        detector_mode:
          'outer_frame_detector_only_v5_2',

        hero_frame:
          preview
            .heroDetection,

        image2_frame:
          preview
            .image2Detection,

        visual_consistency: {
          passed:
            false,

          reason:
            'Detector-only mode requires human visual confirmation before frame transfer is enabled.',

          both_frames_high_confidence:
            bothHigh
        },

        compare_url:
          `${publicBase()}/preview/thumbnail-repair/${preview.token}/compare`,

        preview_token:
          preview.token,

        upload_blocked_by_consistency:
          true,

        artwork_transfer_performed:
          false,

        etsy_modified:
          false
      });

    } catch (err) {
      next(
        err
      );
    }
  }
);

/* =========================================================
   APPLY DISABLED IN V5.2
========================================================= */

app.post(
  '/api/listings/:listingId/thumbnail-repair/apply',
  async (
    req,
    res
  ) => {
    return res
      .status(409)
      .json({
        error:
          'detector_only_mode_upload_blocked',

        message:
          'V5.2 only verifies full outer-frame detection. Artwork transfer and Etsy upload are intentionally disabled.',

        listing_id:
          Number(
            req.params
              .listingId
          ),

        etsy_modified:
          false
      });
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

      const cleanupToken =
        String(
          req.body
            ?.cleanup_token ||
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
          payload
            .listingId
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
              'Cleanup blocked because listing has fewer than two images'
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
            ) ===
            1
        ) ||
        null;

      if (
        !source
      ) {
        return res
          .status(409)
          .json({
            error:
              'Old source image is no longer attached; nothing was deleted'
          });
      }

      if (
        !replacement
      ) {
        return res
          .status(409)
          .json({
            error:
              'Replacement image is missing; cleanup blocked'
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
              'Replacement is not the current rank 1 image; cleanup blocked'
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
              item
                ?.image_id
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
              'Old source image is used by a listing variation; cleanup blocked'
          });
      }

      await etsyRequest(
        `/shops/${await sid()}/listings/${listingId}/images/${payload.sourceImageId}`,
        {
          method:
            'DELETE'
        }
      );

      const afterData =
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

        current_images:
          afterData
            ?.results ||
          [],

        listing_fields_changed:
          false
      });

    } catch (err) {
      next(
        err
      );
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
      next(
        err
      );
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

      if (
        !title
      ) {
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
      next(
        err
      );
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
          req.params
            .sectionId
        );

      const title =
        String(
          req.body
            ?.title ||
          ''
        ).trim();

      if (
        !title
      ) {
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
      next(
        err
      );
    }
  }
);

/* =========================================================
   ERROR
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
