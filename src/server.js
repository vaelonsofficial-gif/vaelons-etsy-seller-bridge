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

    err.status = 400;
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

    err.status = 400;
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
    image
      ?.listing_image_id ??
    image
      ?.image_id ??
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
      uploadResult
        .results[0] ||
      null
    );
  }

  return uploadResult;
}


/* =========================================================
   LISTING IMAGE HELPERS
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


async function normalizeImage(
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
    .png()
    .toBuffer();
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

  const luminanceValues =
    [];

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

    luminanceValues.push(
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

    if (y < 55) {
      shadowCount += 1;
    }

    if (y < 28) {
      deepShadowCount +=
        1;
    }

    if (y > 230) {
      highlightCount +=
        1;
    }

    pixelCount +=
      1;
  }

  luminanceValues.sort(
    (
      a,
      b
    ) => a - b
  );

  const count =
    pixelCount ||
    1;

  const brightness =
    Math.round(
      sumL /
      count
    );

  let varianceSum =
    0;

  for (
    const value of
    luminanceValues
  ) {
    const delta =
      value -
      brightness;

    varianceSum +=
      delta *
      delta;
  }

  const contrast =
    Math.round(
      Math.sqrt(
        varianceSum /
        count
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

  const meanR =
    sumR /
    count;

  const meanG =
    sumG /
    count;

  const meanB =
    sumB /
    count;

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
          meanR
        ),

      g:
        round1(
          meanG
        ),

      b:
        round1(
          meanB
        )
    },

    mean_chroma:
      round1(
        sumChroma /
        count
      ),

    color_balance: {
      r_minus_g:
        round1(
          meanR -
          meanG
        ),

      b_minus_g:
        round1(
          meanB -
          meanG
        )
    }
  };
}


/* =========================================================
   THUMBNAIL SCORE
========================================================= */

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

  if (
    b < 50
  ) {
    score -= 34;

  } else if (
    b < 60
  ) {
    score -= 27;

  } else if (
    b < 70
  ) {
    score -= 19;

  } else if (
    b < 80
  ) {
    score -= 11;

  } else if (
    b < 90
  ) {
    score -= 5;
  }

  if (
    shadows > 60
  ) {
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

  if (
    deep > 38
  ) {
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

  if (
    highlights > 14
  ) {
    score -= 8;

  } else if (
    highlights > 8
  ) {
    score -= 4;
  }

  if (
    range < 55
  ) {
    score -= 12;

  } else if (
    range < 70
  ) {
    score -= 6;
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
      'prepare_reference_frame_preview';

  } else if (
    score < 60
  ) {
    priority =
      'high';

    action =
      'prepare_reference_frame_preview';

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
      false,

    reason:
      action ===
      'keep'
        ? 'Thumbnail readability is within the conservative safe range.'
        : 'Thumbnail should be visually reviewed before any Etsy change.'
  };
}


/* =========================================================
   FRAME DETECTION V5

   Fail-closed heuristic.
   It is intended for roughly front-facing rectangular
   canvas/frame presentations.

   If the frame cannot be detected confidently,
   the system refuses to prepare the replacement.
========================================================= */

function median(values) {
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

  const mid =
    Math.floor(
      sorted.length /
      2
    );

  return (
    sorted.length %
    2
  )
    ? sorted[mid]
    : (
        sorted[
          mid - 1
        ] +
        sorted[mid]
      ) /
      2;
}


function smoothArray(
  values,
  radius = 4
) {
  const out =
    new Array(
      values.length
    ).fill(0);

  for (
    let i = 0;
    i < values.length;
    i += 1
  ) {
    let sum = 0;
    let count = 0;

    const start =
      Math.max(
        0,
        i - radius
      );

    const end =
      Math.min(
        values.length -
        1,
        i + radius
      );

    for (
      let j = start;
      j <= end;
      j += 1
    ) {
      sum +=
        values[j];

      count +=
        1;
    }

    out[i] =
      count
        ? sum /
          count
        : values[i];
  }

  return out;
}


function topPeaks(
  values,
  minIndex,
  maxIndex,
  count = 18,
  spacing = 8
) {
  const candidates =
    [];

  for (
    let i = minIndex;
    i <= maxIndex;
    i += 1
  ) {
    candidates.push({
      i,

      value:
        values[i] ||
        0
    });
  }

  candidates.sort(
    (
      a,
      b
    ) =>
      b.value -
      a.value
  );

  const chosen =
    [];

  for (
    const candidate of
    candidates
  ) {
    if (
      chosen.every(
        (peak) =>
          Math.abs(
            peak.i -
            candidate.i
          ) >=
          spacing
      )
    ) {
      chosen.push(
        candidate
      );

      if (
        chosen.length >=
        count
      ) {
        break;
      }
    }
  }

  return chosen;
}


async function detectArtworkFrame(
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
      .removeAlpha()
      .greyscale()
      .resize({
        width:
          520,

        height:
          520,

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

  const w =
    info.width;

  const h =
    info.height;

  const vEdge =
    new Array(w)
      .fill(0);

  const hEdge =
    new Array(h)
      .fill(0);

  const yMin =
    Math.floor(
      h *
      0.08
    );

  const yMax =
    Math.ceil(
      h *
      0.92
    );

  const xMin =
    Math.floor(
      w *
      0.08
    );

  const xMax =
    Math.ceil(
      w *
      0.92
    );

  for (
    let y =
      yMin + 1;

    y <
      yMax - 1;

    y += 1
  ) {
    for (
      let x =
        xMin + 1;

      x <
        xMax - 1;

      x += 1
    ) {
      const idx =
        y *
        w +
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
            idx + w
          ] -
          data[
            idx - w
          ]
        );

      vEdge[x] +=
        gx;

      hEdge[y] +=
        gy;
    }
  }

  const sv =
    smoothArray(
      vEdge,
      4
    );

  const sh =
    smoothArray(
      hEdge,
      4
    );

  const vBase =
    Math.max(
      1,
      median(
        sv.slice(
          xMin,
          xMax + 1
        )
      )
    );

  const hBase =
    Math.max(
      1,
      median(
        sh.slice(
          yMin,
          yMax + 1
        )
      )
    );

  const xPeaks =
    topPeaks(
      sv,
      xMin,
      xMax,
      24,
      Math.max(
        6,
        Math.floor(
          w *
          0.015
        )
      )
    );

  const yPeaks =
    topPeaks(
      sh,
      yMin,
      yMax,
      24,
      Math.max(
        6,
        Math.floor(
          h *
          0.015
        )
      )
    );

  let best =
    null;

  for (
    const leftP of
    xPeaks
  ) {
    for (
      const rightP of
      xPeaks
    ) {
      const left =
        Math.min(
          leftP.i,
          rightP.i
        );

      const right =
        Math.max(
          leftP.i,
          rightP.i
        );

      const rw =
        right -
        left;

      if (
        rw <
          w *
          0.18 ||
        rw >
          w *
          0.78
      ) {
        continue;
      }

      if (
        left >
          w *
          0.58 ||
        right <
          w *
          0.42
      ) {
        continue;
      }

      for (
        const topP of
        yPeaks
      ) {
        for (
          const bottomP of
          yPeaks
        ) {
          const top =
            Math.min(
              topP.i,
              bottomP.i
            );

          const bottom =
            Math.max(
              topP.i,
              bottomP.i
            );

          const rh =
            bottom -
            top;

          if (
            rh <
              h *
              0.18 ||
            rh >
              h *
              0.82
          ) {
            continue;
          }

          if (
            top >
              h *
              0.62 ||
            bottom <
              h *
              0.38
          ) {
            continue;
          }

          const aspect =
            rw /
            rh;

          if (
            aspect <
              0.45 ||
            aspect >
              1.80
          ) {
            continue;
          }

          const cx =
            (
              left +
              right
            ) /
            2 /
            w;

          const cy =
            (
              top +
              bottom
            ) /
            2 /
            h;

          const area =
            (
              rw *
              rh
            ) /
            (
              w *
              h
            );

          const edgeScores =
            [
              sv[left] /
                vBase,

              sv[right] /
                vBase,

              sh[top] /
                hBase,

              sh[bottom] /
                hBase
            ];

          const minEdge =
            Math.min(
              ...edgeScores
            );

          const avgEdge =
            edgeScores.reduce(
              (
                a,
                b
              ) =>
                a + b,
              0
            ) /
            edgeScores.length;

          const desiredCy =
            role ===
            'hero'
              ? 0.42
              : 0.45;

          const centerPenalty =
            Math.abs(
              cx -
              0.5
            ) *
            2.0 +
            Math.abs(
              cy -
              desiredCy
            ) *
            1.25;

          const areaPenalty =
            area <
            0.07
              ? (
                  0.07 -
                  area
                ) *
                10
              : 0;

          const score =
            avgEdge +
            minEdge *
              0.85 -
            centerPenalty -
            areaPenalty;

          if (
            !best ||
            score >
              best.score
          ) {
            best = {
              score,
              left,
              right,
              top,
              bottom,
              edgeScores,
              minEdge,
              avgEdge,
              area,
              aspect,
              cx,
              cy
            };
          }
        }
      }
    }
  }

  if (!best) {
    const err =
      new Error(
        'frame_detection_failed'
      );

    err.status =
      422;

    err.details = {
      role,

      reason:
        'No plausible central rectangular frame found.'
    };

    throw err;
  }

  const confidence =
    clamp(
      (
        best.minEdge -
        1.1
      ) /
      3.5,
      0,
      1
    );

  if (
    confidence <
    0.45
  ) {
    const err =
      new Error(
        'frame_detection_uncertain'
      );

    err.status =
      422;

    err.details = {
      role,

      confidence:
        round1(
          confidence
        ),

      reason:
        'Frame edges are not strong enough for safe automatic replacement.'
    };

    throw err;
  }

  return {
    role,

    confidence:
      round1(
        confidence
      ),

    normalized: {
      x:
        best.left /
        w,

      y:
        best.top /
        h,

      width:
        (
          best.right -
          best.left
        ) /
        w,

      height:
        (
          best.bottom -
          best.top
        ) /
        h
    },

    analysis_size: {
      width:
        w,

      height:
        h
    },

    aspect_ratio:
      round1(
        best.aspect
      ),

    area_ratio:
      round1(
        best.area
      )
  };
}


function insetNormalizedRect(
  rect,
  fraction
) {
  const dx =
    rect.width *
    fraction;

  const dy =
    rect.height *
    fraction;

  return {
    x:
      rect.x +
      dx,

    y:
      rect.y +
      dy,

    width:
      rect.width -
      dx *
      2,

    height:
      rect.height -
      dy *
      2
  };
}


async function normalizedRectToPixels(
  buffer,
  normalizedRect
) {
  const meta =
    await sharp(
      buffer
    ).metadata();

  const width =
    meta.width;

  const height =
    meta.height;

  if (
    !width ||
    !height
  ) {
    throw new Error(
      'Could not read image dimensions'
    );
  }

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


async function cropRect(
  buffer,
  rect
) {
  return sharp(
    buffer
  )
    .extract(
      rect
    )
    .png()
    .toBuffer();
}


/* =========================================================
   FRAME REFERENCE TRANSFER V5

   Image 2 artwork pixels are reused.
   No generative redraw.
========================================================= */

async function renderReferenceFrameTransfer(
  heroBuffer,
  referenceBuffer
) {
  const hero =
    await normalizeImage(
      heroBuffer
    );

  const reference =
    await normalizeImage(
      referenceBuffer
    );

  const heroFrame =
    await detectArtworkFrame(
      hero,
      'hero'
    );

  const referenceFrame =
    await detectArtworkFrame(
      reference,
      'reference'
    );

  /*
    Slight inset:
    avoids copying visible frame borders.
  */

  const heroInnerNorm =
    insetNormalizedRect(
      heroFrame.normalized,
      0.055
    );

  const referenceInnerNorm =
    insetNormalizedRect(
      referenceFrame.normalized,
      0.035
    );

  const heroTarget =
    await normalizedRectToPixels(
      hero,
      heroInnerNorm
    );

  const referenceCropRect =
    await normalizedRectToPixels(
      reference,
      referenceInnerNorm
    );

  const heroAspect =
    heroTarget.width /
    heroTarget.height;

  const referenceAspect =
    referenceCropRect.width /
    referenceCropRect.height;

  const aspectMismatch =
    Math.abs(
      Math.log(
        heroAspect /
        referenceAspect
      )
    );

  /*
    Fail closed.
    We do not want to visibly stretch or crop
    the product artwork.
  */

  if (
    aspectMismatch >
    0.08
  ) {
    const err =
      new Error(
        'artwork_aspect_ratio_mismatch'
      );

    err.status =
      422;

    err.details = {
      hero_target_aspect:
        round1(
          heroAspect
        ),

      image2_artwork_aspect:
        round1(
          referenceAspect
        ),

      mismatch:
        round1(
          aspectMismatch
        ),

      reason:
        'Automatic placement would require too much stretching or cropping.'
    };

    throw err;
  }

  const referenceArtwork =
    await cropRect(
      reference,
      referenceCropRect
    );

  /*
    Because aspect mismatch is already limited,
    this resize only performs small resampling.
  */

  const placedArtwork =
    await sharp(
      referenceArtwork
    )
      .resize(
        heroTarget.width,
        heroTarget.height,
        {
          fit:
            'fill',

          kernel:
            sharp.kernel
              .lanczos3
        }
      )
      .png()
      .toBuffer();

  /*
    Only the detected frame interior
    is composited.

    The whole hero image is not cropped,
    reframed or regenerated.
  */

  const composed =
    await sharp(
      hero
    )
      .composite([
        {
          input:
            placedArtwork,

          left:
            heroTarget.left,

          top:
            heroTarget.top,

          blend:
            'over'
        }
      ])
      .jpeg({
        quality:
          97,

        chromaSubsampling:
          '4:4:4',

        mozjpeg:
          true
      })
      .toBuffer();

  const referenceAnalysis =
    await analyzeImage(
      referenceArtwork
    );

  const placedAnalysis =
    await analyzeImage(
      placedArtwork
    );

  return {
    composed,

    heroFrame,
    referenceFrame,

    heroTarget,
    referenceCropRect,

    heroInnerNorm,
    referenceInnerNorm,

    aspectMismatch,

    referenceArtwork,

    referenceAnalysis,
    placedAnalysis
  };
}


/* =========================================================
   TRANSFER SAFETY
========================================================= */

function colorBalanceDistance(
  a,
  b
) {
  if (
    !a?.color_balance ||
    !b?.color_balance
  ) {
    return 0;
  }

  return Math.sqrt(
    Math.pow(
      Number(
        a.color_balance
          .r_minus_g
      ) -
      Number(
        b.color_balance
          .r_minus_g
      ),
      2
    ) +
    Math.pow(
      Number(
        a.color_balance
          .b_minus_g
      ) -
      Number(
        b.color_balance
          .b_minus_g
      ),
      2
    )
  );
}


function assessFrameTransfer(
  rendered
) {
  const reference =
    rendered
      .referenceAnalysis;

  const placed =
    rendered
      .placedAnalysis;

  const colorBalanceDrift =
    colorBalanceDistance(
      reference,
      placed
    );

  const chromaDelta =
    Math.abs(
      reference.mean_chroma -
      placed.mean_chroma
    );

  const brightnessDelta =
    Math.abs(
      reference
        .brightness_0_255 -
      placed
        .brightness_0_255
    );

  const warnings =
    [];

  if (
    rendered
      .heroFrame
      .confidence <
    0.5
  ) {
    warnings.push(
      'hero_frame_detection_low_confidence'
    );
  }

  if (
    rendered
      .referenceFrame
      .confidence <
    0.5
  ) {
    warnings.push(
      'image2_frame_detection_low_confidence'
    );
  }

  if (
    rendered
      .aspectMismatch >
    0.06
  ) {
    warnings.push(
      'artwork_aspect_ratio_near_limit'
    );
  }

  if (
    colorBalanceDrift >
    3
  ) {
    warnings.push(
      'reference_color_balance_drift'
    );
  }

  if (
    chromaDelta >
    5
  ) {
    warnings.push(
      'reference_chroma_drift'
    );
  }

  if (
    brightnessDelta >
    8
  ) {
    warnings.push(
      'reference_brightness_drift'
    );
  }

  const hardWarnings =
    warnings.filter(
      (warning) =>
        warning !==
        'artwork_aspect_ratio_near_limit'
    );

  return {
    passed:
      hardWarnings.length ===
      0,

    hard_block_upload:
      hardWarnings.length >
      0,

    warnings,

    hero_frame_confidence:
      rendered
        .heroFrame
        .confidence,

    image2_frame_confidence:
      rendered
        .referenceFrame
        .confidence,

    aspect_mismatch:
      round1(
        rendered
          .aspectMismatch
      ),

    reference_color_balance_drift:
      round1(
        colorBalanceDrift
      ),

    reference_chroma_delta:
      round1(
        chromaDelta
      ),

    reference_brightness_delta:
      round1(
        brightnessDelta
      ),

    non_generative_reference_pixels_used:
      true,

    hero_outer_scene_edit_operation:
      false,

    artwork_source:
      'etsy_image_2_reference_pixels',

    note:
      'Only the detected hero frame interior is replaced. Image 2 artwork pixels are reused and resampled to the detected frame opening. If detection is uncertain, the operation is blocked.'
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
      token ||
      ''
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
   BUILD V5 PREVIEW
========================================================= */

async function buildFramePreview(
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

    err.details = {
      reason:
        'Image 2 is required as the artwork truth reference for frame transfer.'
    };

    throw err;
  }

  const [
    {
      buffer:
        heroBuffer
    },

    {
      buffer:
        referenceBuffer
    }
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
    before,
    image2Analysis
  ] =
    await Promise.all([
      analyzeImage(
        heroBuffer
      ),

      analyzeImage(
        referenceBuffer
      )
    ]);

  const rendered =
    await renderReferenceFrameTransfer(
      heroBuffer,
      referenceBuffer
    );

  const after =
    await analyzeImage(
      rendered.composed
    );

  const transferSafety =
    assessFrameTransfer(
      rendered
    );

  const token =
    signToken({
      type:
        'thumbnail_preview_v5',

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

      heroFrame:
        rendered
          .heroFrame
          .normalized,

      referenceFrame:
        rendered
          .referenceFrame
          .normalized,

      method:
        'image2_reference_frame_transfer_v5',

      exp:
        Date.now() +
        PREVIEW_TTL_MS
    });

  return {
    listing,
    imageSet,
    before,
    after,
    image2Analysis,
    rendered,
    transferSafety,
    token
  };
}


async function rebuildFromToken(
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

    err.status =
      409;

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

    err.status =
      409;

    throw err;
  }

  const [
    {
      buffer:
        heroBuffer
    },

    {
      buffer:
        referenceBuffer
    }
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

  const rendered =
    await renderReferenceFrameTransfer(
      heroBuffer,
      referenceBuffer
    );

  if (
    rectDistance(
      rendered
        .heroFrame
        .normalized,
      payload.heroFrame
    ) >
      0.025 ||
    rectDistance(
      rendered
        .referenceFrame
        .normalized,
      payload.referenceFrame
    ) >
      0.025
  ) {
    const err =
      new Error(
        'Frame detection changed after preview; create a new preview'
      );

    err.status =
      409;

    throw err;
  }

  return {
    imageSet,
    heroBuffer,
    referenceBuffer,
    rendered
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

  return Number.isFinite(
    age
  )
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
      listing
        ?.num_favorers ??
      0
    );

  if (
    ageDays ===
    null
  ) {
    return {
      age_days:
        null,

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
        getImageId(
          img
        ),

      rank:
        img.rank ??
        null,

      image_url:
        getImageUrl(
          img
        )
    })
  );
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
        'vaelons-etsy-seller-bridge',

      thumbnail_engine:
        'image2_reference_frame_transfer_v5'
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
   PUBLIC PREVIEW IMAGE V5
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
          'thumbnail_preview_v5'
        );

      const listingId =
        asListingId(
          payload
            .listingId
        );

      const rebuilt =
        await rebuildFromToken(
          listingId,
          payload
        );

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.setHeader(
        'content-disposition',
        'inline; filename="thumbnail-image2-reference-frame-v5.jpg"'
      );

      res.setHeader(
        'cache-control',
        'private, max-age=300'
      );

      res.send(
        rebuilt
          .rendered
          .composed
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
   PUBLIC THREE-WAY COMPARE V5
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
          'thumbnail_preview_v5'
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

      const rebuilt =
        await rebuildFromToken(
          listingId,
          payload
        );

      const imageSet =
        rebuilt.imageSet;

      const token =
        encodeURIComponent(
          req.params.token
        );

      const beforeUrl =
        imageSet
          .rank1
          .imageUrl;

      const referenceUrl =
        imageSet
          .rank2
          .imageUrl;

      const afterUrl =
        `${publicBase()}/preview/thumbnail-repair/${token}`;

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
Rank 1:
${esc(
  imageSet
    .rank1
    .imageId
)}
·
Image 2:
${esc(
  imageSet
    .rank2
    .imageId
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

<div class="card">

<div class="label">
REFERANS — Etsy Image 2
</div>

<img
  src="${esc(referenceUrl)}"
  alt="Image 2 reference"
>

</div>

<div class="card">

<div class="label">
SONRA — Image 2 artwork + mevcut hero mockup
</div>

<img
  src="${esc(afterUrl)}"
  alt="After"
>

</div>

</div>

<div class="note">
V5 generative redraw kullanmaz.
Image 2'de algılanan artwork piksellerini,
mevcut rank-1 hero sahnesindeki algılanan çerçeve iç alanına yerleştirir.
Çerçeve tespiti güvenilir değilse sistem işlemi bloklar.
Bu sayfa Etsy'de hiçbir değişiklik yapmaz.
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
   API AUTH
========================================================= */

app.use(
  '/api',
  bridgeAuth
);


/* =========================================================
   CONNECTION
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
            fileRef.name ||
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

                state:
                  listing
                    .state,

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
                  ),

                available_performance_signal:
                  performanceSignal(
                    listing
                  ),

                note:
                  'Only available Etsy listing signals are used. Missing CTR, conversion or view data is never invented.'
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

      const order = {
        urgent:
          0,

        high:
          1,

        review:
          2,

        none:
          3
      };

      scanned.sort(
        (
          a,
          b
        ) => {
          const pa =
            order[
              a
                ?.assessment
                ?.priority
            ] ??
            9;

          const pb =
            order[
              b
                ?.assessment
                ?.priority
            ] ??
            9;

          if (
            pa !==
            pb
          ) {
            return (
              pa -
              pb
            );
          }

          return (
            (
              a
                ?.assessment
                ?.readability_score_0_100 ??
              100
            ) -
            (
              b
                ?.assessment
                ?.readability_score_0_100 ??
              100
            )
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
      next(
        err
      );
    }
  }
);


/* =========================================================
   PREVIEW V5
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
          req.params
            .listingId
        );

      const preview =
        await buildFramePreview(
          listingId
        );

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

        preview_file_name:
          `etsy-${listingId}-image2-reference-frame-v5.jpg`,

        preview_url:
          `${publicBase()}/preview/thumbnail-repair/${preview.token}`,

        compare_url:
          `${publicBase()}/preview/thumbnail-repair/${preview.token}/compare`,

        before:
          preview.before,

        after:
          preview.after,

        image2_reference_analysis:
          preview
            .image2Analysis,

        assessment:
          assessThumbnail(
            preview.before
          ),

        frame_detection: {
          hero:
            preview
              .rendered
              .heroFrame,

          image2:
            preview
              .rendered
              .referenceFrame
        },

        visual_consistency:
          preview
            .transferSafety,

        repair: {
          type:
            'image2_reference_frame_transfer_v5',

          generative_redraw_used:
            false,

          image2_reference_pixels_reused:
            true,

          hero_outer_scene_edit_operation:
            false,

          hero_whole_image_crop_changed:
            false,

          hero_whole_image_geometry_changed:
            false,

          artwork_content_source:
            'etsy_image_2',

          target_region:
            preview
              .rendered
              .heroInnerNorm,

          reference_region:
            preview
              .rendered
              .referenceInnerNorm,

          note:
            'The current hero remains the scene base. Only the detected frame interior is replaced with detected Image 2 artwork pixels.'
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
          !preview
            .transferSafety
            .passed,

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
   APPLY V5
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
          req.params
            .listingId
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
          'thumbnail_preview_v5'
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
              'Preview token belongs to another listing'
          });
      }

      const listing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const rebuilt =
        await rebuildFromToken(
          listingId,
          payload
        );

      const imageSet =
        rebuilt
          .imageSet;

      const transferSafety =
        assessFrameTransfer(
          rebuilt
            .rendered
        );

      if (
        !transferSafety
          .passed
      ) {
        return res
          .status(409)
          .json({
            error:
              'Visual consistency safety check failed before upload',

            visual_consistency:
              transferSafety,

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
            rebuilt
              .rendered
              .composed,

          filename:
            `etsy-${listingId}-image2-reference-frame-v5.jpg`,

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
        postImagesData
          ?.results ||
        [];

      const currentRank1 =
        postImages.find(
          (img) =>
            Number(
              img.rank
            ) ===
            1
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
                imageSet
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
            newImageIsRank1
          ),

        exact_title:
          listing
            ?.title ??
          null,

        listing_id:
          Number(
            listingId
          ),

        source_image_id:
          imageSet
            .rank1
            .imageId,

        image2_reference_id:
          imageSet
            .rank2
            .imageId,

        uploaded_image_id:
          uploadedImageId,

        current_rank1_image_id:
          currentRank1Id,

        replacement_verified_as_rank1:
          newImageIsRank1,

        visual_consistency:
          transferSafety,

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
      next(
        err
      );
    }
  }
);


/* =========================================================
   CLEANUP
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

      if (!source) {
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

      if (
        String(
          getImageId(
            source
          )
        ) ===
        String(
          getImageId(
            rank1
          )
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
            results:
              []
          })
        );

      const sourceUsedByVariation =
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
        const probe =
          await getListingImages(
            listingId
          ).catch(
            () =>
              null
          );

        const stillExists =
          (
            probe
              ?.results ||
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
      }

      const afterData =
        await getListingImages(
          listingId
        );

      const afterImages =
        afterData
          ?.results ||
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

        current_images:
          compactImageList(
            afterData
          ),

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
      next(
        err
      );
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
