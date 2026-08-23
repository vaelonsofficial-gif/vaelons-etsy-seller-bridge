import express from 'express';
import sharp from 'sharp';
import OpenAI, { toFile } from 'openai';
import { Redis } from '@upstash/redis';
import { randomBytes, createHash } from 'node:crypto';

import { randomBase64Url, pkceChallenge, sealJson, openJson } from './crypto.js';
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
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

let openaiClient = null;
let redisClient = null;

const WORKER_VERSION = '3.1.0';
const PREFIX = 'vaelons:thumbnail-worker:v2';
const PREVIEW_TTL_SECONDS = 24 * 60 * 60;
const QA_RETRY_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const LOCK_TTL_SECONDS = 10 * 60;
const WORKER_MODE = 'safe';
const WORKER_BATCH_SIZE = clampInt(process.env.WORKER_BATCH_SIZE || 2, 1, 5);
const BAD_SCORE_THRESHOLD = clampInt(process.env.BAD_SCORE_THRESHOLD || 65, 20, 95);
const DARK_BRIGHTNESS_THRESHOLD = clampInt(process.env.DARK_BRIGHTNESS_THRESHOLD || 78, 30, 150);
const AUTO_DELETE_OLD_RANK1 = envBool('AUTO_DELETE_OLD_RANK1', true);
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const QA_MODEL = process.env.OPENAI_QA_MODEL || 'gpt-5.6-luna';
const COMPLIANCE_MODEL = process.env.OPENAI_COMPLIANCE_MODEL || QA_MODEL;
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'high';
const STRICT_MAX_ATTEMPTS = clampInt(process.env.THUMBNAIL_MAX_ATTEMPTS || 3, 2, 3);
const RECENT_SCENE_HISTORY_LIMIT = 12;
const RECENT_QA_COMPARISON_LIMIT = 3;

const HARD_FORBIDDEN = [
  'potted plant', 'indoor plant', 'planter', 'flower pot', 'vase', 'decorative vessel',
  'bouquet', 'decorative branches', 'books', 'magazines', 'console table', 'sideboard',
  'credenza', 'styled shelf', 'styled tabletop'
];

const SCENE_FAMILIES = [
  {
    id: 'bare_gallery', label: 'Bare Gallery Wall', signature: 'bare_gallery+zero_props',
    description: 'Bright frontal gallery wall, generous negative space, no furniture below the artwork.',
    allowed: ['wall', 'floor', 'architectural trim', 'neutral daylight'],
    rule: 'Nothing may sit directly below the artwork.'
  },
  {
    id: 'low_sofa_wall', label: 'Low Sofa Wall', signature: 'low_sofa+empty_wall',
    description: 'Bright living space with only the top edge of one low neutral sofa at the bottom.',
    allowed: ['one low neutral sofa', 'wall', 'floor', 'neutral daylight'],
    rule: 'Sofa stays low and bare. No object or furniture centered under artwork.'
  },
  {
    id: 'headboard_wall', label: 'Headboard Wall', signature: 'headboard+empty_wall',
    description: 'Bright calm bedroom with low headboard and plain bedding only.',
    allowed: ['low headboard', 'plain bedding', 'wall', 'neutral daylight'],
    rule: 'No bedside tables, lamps, props, plants, vessels or books.'
  },
  {
    id: 'stair_landing', label: 'Architectural Stair Landing', signature: 'stairs+empty_wall',
    description: 'Bright stair landing with clean railing geometry and no decorative furniture.',
    allowed: ['stairs', 'railing', 'wall', 'neutral daylight'],
    rule: 'Architecture only; no movable decor.'
  },
  {
    id: 'dining_wall', label: 'Clean Dining Wall', signature: 'bare_table_edge+chairs',
    description: 'Bright dining wall with simple chair backs and optionally a bare table edge low in frame.',
    allowed: ['simple chairs', 'bare dining table edge', 'wall', 'neutral daylight'],
    rule: 'Table surface must be completely bare.'
  },
  {
    id: 'arched_hall', label: 'Arched Hall', signature: 'arches+architecture_only',
    description: 'Bright plaster or limestone hall with arches and no decorative furniture.',
    allowed: ['arches', 'plaster or limestone wall', 'floor', 'neutral daylight'],
    rule: 'Architecture provides all visual interest.'
  },
  {
    id: 'loft_wall', label: 'Modern Loft Wall', signature: 'loft+single_chair',
    description: 'Bright clean loft wall with at most one simple chair far from the artwork.',
    allowed: ['one simple chair', 'plaster or concrete wall', 'floor', 'neutral daylight'],
    rule: 'At most one chair; no table, shelf, lamp or decor cluster.'
  },
  {
    id: 'window_side_wall', label: 'Window-Side Wall', signature: 'window+empty_wall',
    description: 'Bright wall beside a clean architectural window opening.',
    allowed: ['window opening', 'wall', 'floor', 'neutral daylight'],
    rule: 'Window is architecture only; no indoor greenery or furniture styling.'
  },
  {
    id: 'museum_wall', label: 'Museum Minimal', signature: 'museum+zero_props',
    description: 'Premium museum-like wall with subtle texture and no furniture or decor.',
    allowed: ['museum wall', 'floor', 'architectural texture', 'diffuse neutral light'],
    rule: 'Zero props and zero furniture.'
  }
];

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function publicBase() {
  return required('PUBLIC_BASE_URL').replace(/\/$/, '');
}

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function clampInt(value, min, max) {
  return Math.round(clamp(value, min, max));
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function asListingId(value) {
  const id = String(value || '').trim();
  if (!/^\d+$/.test(id)) {
    const e = new Error('Invalid listingId');
    e.status = 400;
    throw e;
  }
  return id;
}

function getImageId(image) {
  return image?.listing_image_id ?? image?.image_id ?? null;
}

function getImageUrl(image) {
  return image?.url_fullxfull ||
    image?.url_570xN ||
    image?.url_300x300 ||
    image?.url_170x135 ||
    null;
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) {
      out[part.slice(0, i).trim()] =
        decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return out;
}

function bridgeAuth(req, res, next) {
  const key = process.env.BRIDGE_API_KEY || '';
  if (
    !key ||
    (req.get('authorization') || '') !== `Bearer ${key}`
  ) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function workerAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const cron = process.env.CRON_SECRET || '';
  const bridge = process.env.BRIDGE_API_KEY || '';

  if (
    !(
      (cron && auth === `Bearer ${cron}`) ||
      (bridge && auth === `Bearer ${bridge}`)
    )
  ) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}

function openai() {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: required('VAELONS_OPENAI_API_KEY')
    });
  }
  return openaiClient;
}

function redis() {
  if (!redisClient) {
    const url =
      process.env.UPSTASH_REDIS_REST_KV_REST_API_URL ||
      process.env.UPSTASH_REDIS_REST_URL;

    const token =
      process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN ||
      process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!url || !token) {
      throw new Error(
        'Missing Upstash Redis REST environment variables'
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

const stateKey = id => `${PREFIX}:listing:${id}`;
const previewKey = token => `${PREFIX}:preview:${token}`;
const previewImageKey = token => `${PREFIX}:preview-image:${token}`;
const sceneHistoryKey = () => `${PREFIX}:scene-history`;

async function getJson(key) {
  const raw = await redis().get(key);

  if (raw == null) return null;
  if (typeof raw === 'object') return raw;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function setJson(key, value, options = {}) {
  return redis().set(
    key,
    JSON.stringify(value),
    options
  );
}

async function downloadImage(url) {
  const parsed = new URL(url);

  if (parsed.protocol !== 'https:') {
    throw new Error('Image URL must use HTTPS');
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Could not download image (${response.status})`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length > 20 * 1024 * 1024) {
    const e = new Error('Image is larger than 20 MB');
    e.status = 413;
    throw e;
  }

  return buffer;
}

async function normalizeJpeg(
  buffer,
  max = 1600,
  quality = 90
) {
  return sharp(buffer)
    .rotate()
    .removeAlpha()
    .toColourspace('srgb')
    .resize({
      width: max,
      height: max,
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({
      quality,
      chromaSubsampling: '4:4:4'
    })
    .toBuffer();
}

async function analyzeImage(buffer) {
  const meta = await sharp(buffer).metadata();

  const { data, info } =
    await sharp(buffer)
      .rotate()
      .removeAlpha()
      .greyscale()
      .resize({
        width: 360,
        height: 360,
        fit: 'inside',
        withoutEnlargement: true
      })
      .raw()
      .toBuffer({
        resolveWithObject: true
      });

  let sum = 0;
  let sumSq = 0;
  let shadow = 0;
  let deepShadow = 0;
  let highlight = 0;

  const count =
    Math.max(
      1,
      info.width * info.height
    );

  for (
    let i = 0;
    i < data.length;
    i += info.channels
  ) {
    const y = data[i];

    sum += y;
    sumSq += y * y;

    if (y < 55) shadow++;
    if (y < 28) deepShadow++;
    if (y > 235) highlight++;
  }

  const mean = sum / count;

  return {
    width: meta.width || null,
    height: meta.height || null,
    brightness: round1(mean),
    contrast: round1(
      Math.sqrt(
        Math.max(
          0,
          sumSq / count - mean * mean
        )
      )
    ),
    shadow_percent:
      round1(
        shadow / count * 100
      ),
    deep_shadow_percent:
      round1(
        deepShadow / count * 100
      ),
    highlight_percent:
      round1(
        highlight / count * 100
      )
  };
}

function thumbnailScore(a) {
  let score = 100;

  if (a.brightness < 50) score -= 40;
  else if (a.brightness < 65) score -= 30;
  else if (a.brightness < 78) score -= 18;
  else if (a.brightness < 90) score -= 8;

  if (a.shadow_percent > 60) score -= 25;
  else if (a.shadow_percent > 48) score -= 15;
  else if (a.shadow_percent > 38) score -= 8;

  if (a.deep_shadow_percent > 35) score -= 12;
  else if (a.deep_shadow_percent > 25) score -= 6;

  if (a.contrast < 25) score -= 10;
  if (a.highlight_percent > 16) score -= 8;

  return clampInt(
    score,
    0,
    100
  );
}

function heuristicReferenceScore(
  a,
  rank
) {
  const resolution =
    Math.max(
      1,
      (a.width || 1) *
      (a.height || 1)
    );

  return round1(
    70 -
    Math.abs(a.brightness - 120) * 0.35 +
    clamp(a.contrast - 25, 0, 30) * 0.7 +
    clamp(
      Math.log10(resolution) - 5.5,
      0,
      1.5
    ) * 8 +
    (
      rank === 2
        ? 8
        : rank === 3
          ? 4
          : 0
    )
  );
}

async function getImageSet(listingId) {
  const data =
    await getListingImages(
      listingId
    );

  const images =
    Array.isArray(data?.results)
      ? data.results
      : [];

  if (!images.length) {
    const e =
      new Error(
        'No listing images found'
      );
    e.status = 404;
    throw e;
  }

  const ordered =
    [...images].sort(
      (a, b) =>
        Number(a.rank ?? 9999) -
        Number(b.rank ?? 9999)
    );

  const rank1 =
    images.find(
      x => Number(x.rank) === 1
    ) ||
    ordered[0];

  if (
    !rank1 ||
    !getImageUrl(rank1)
  ) {
    const e =
      new Error(
        'No usable rank 1 image'
      );
    e.status = 404;
    throw e;
  }

  return {
    images: ordered,
    rank1
  };
}

async function selectReferencesWithVision(
  title,
  candidates
) {
  if (candidates.length === 1) {
    return [candidates[0]];
  }

  const content = [
    {
      type: 'input_text',
      text:
        `Select product-truth references for an Etsy wall-art hero image.

Listing: ${title || ''}

Only the wall art/canvas/frame is the product.

The surrounding room, furniture, plants, pots, vases, books, shelves, tables and decor are NOT product truth.

Prefer close, straight, complete, high-resolution artwork views over lifestyle room mockups.

Choose one primary and at most one useful secondary.

Candidate images follow, indexed from 0.`
    }
  ];

  for (
    let i = 0;
    i < candidates.length;
    i++
  ) {
    const c = candidates[i];

    const jpeg =
      await normalizeJpeg(
        c.buffer,
        1200,
        88
      );

    content.push({
      type: 'input_text',
      text:
        `Candidate ${i}: rank ${c.rank}, image ${c.imageId}`
    });

    content.push({
      type: 'input_image',
      image_url:
        `data:image/jpeg;base64,${jpeg.toString('base64')}`,
      detail: 'high'
    });
  }

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'primary_index',
      'use_secondary',
      'secondary_index',
      'confidence',
      'reason'
    ],
    properties: {
      primary_index: {
        type: 'integer'
      },
      use_secondary: {
        type: 'boolean'
      },
      secondary_index: {
        type: 'integer'
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

  try {
    const r =
      await openai()
        .responses
        .create({
          model: QA_MODEL,
          store: false,
          input: [
            {
              role: 'user',
              content
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'reference_selector_v31',
              strict: true,
              schema
            }
          }
        });

    const p =
      JSON.parse(
        r.output_text ||
        '{}'
      );

    const a =
      Number(
        p.primary_index
      );

    const b =
      Number(
        p.secondary_index
      );

    if (
      Number.isInteger(a) &&
      a >= 0 &&
      a < candidates.length
    ) {
      const out = [
        candidates[a]
      ];

      if (
        p.use_secondary === true &&
        Number.isInteger(b) &&
        b >= 0 &&
        b < candidates.length &&
        b !== a
      ) {
        out.push(
          candidates[b]
        );
      }

      return out.slice(0, 2);
    }
  } catch (e) {
    console.warn(
      'Reference selector fallback:',
      e.message
    );
  }

  return [...candidates]
    .sort(
      (a, b) =>
        b.heuristicScore -
        a.heuristicScore
    )
    .slice(0, 2);
}

async function selectReferences(
  title,
  imageSet
) {
  const raw =
    imageSet.images
      .filter(
        x =>
          Number(x.rank) !== 1 &&
          getImageUrl(x)
      )
      .slice(0, 6);

  const source =
    raw.length
      ? raw
      : [imageSet.rank1];

  const candidates = [];

  for (const image of source) {
    try {
      const buffer =
        await downloadImage(
          getImageUrl(image)
        );

      const analysis =
        await analyzeImage(
          buffer
        );

      const rank =
        Number(
          image.rank || 99
        );

      candidates.push({
        image,
        imageId:
          getImageId(image),
        rank,
        buffer,
        analysis,
        heuristicScore:
          heuristicReferenceScore(
            analysis,
            rank
          )
      });
    } catch (e) {
      console.warn(
        'Reference candidate failed:',
        getImageId(image),
        e.message
      );
    }
  }

  if (!candidates.length) {
    throw new Error(
      'Could not obtain a usable reference image'
    );
  }

  return selectReferencesWithVision(
    title,
    candidates
  );
}

async function isolateArtworkReference(
  title,
  buffer,
  index
) {
  const image =
    await normalizeJpeg(
      buffer,
      1600,
      94
    );

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'found',
      'confidence',
      'x',
      'y',
      'width',
      'height',
      'reason'
    ],
    properties: {
      found: {
        type: 'boolean'
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      x: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      y: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      width: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      height: {
        type: 'number',
        minimum: 0,
        maximum: 1
      },
      reason: {
        type: 'string'
      }
    }
  };

  try {
    const r =
      await openai()
        .responses
        .create({
          model:
            COMPLIANCE_MODEL,
          store: false,
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text:
                    `Locate ONLY the physical wall-art product.

Listing: ${title || ''}.
Reference ${index}.

Return a normalized bounding box around the complete artwork/canvas/frame.

Exclude the entire surrounding room and every furniture/decor object.

Include a visible frame only if it belongs to the product.

If not reliable set found=false.

Do not guess.`
                },
                {
                  type: 'input_image',
                  image_url:
                    `data:image/jpeg;base64,${image.toString('base64')}`,
                  detail: 'high'
                }
              ]
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'artwork_bbox_v31',
              strict: true,
              schema
            }
          }
        });

    const p =
      JSON.parse(
        r.output_text ||
        '{}'
      );

    if (
      p.found !== true ||
      Number(
        p.confidence || 0
      ) < 0.72
    ) {
      return {
        ok: false,
        reason:
          p.reason ||
          'bbox_not_confident',
        confidence:
          Number(
            p.confidence || 0
          )
      };
    }

    const meta =
      await sharp(image)
        .metadata();

    const W =
      Number(
        meta.width || 0
      );

    const H =
      Number(
        meta.height || 0
      );

    const x =
      clamp(p.x, 0, 1);

    const y =
      clamp(p.y, 0, 1);

    const w =
      clamp(
        p.width,
        0,
        1
      );

    const h =
      clamp(
        p.height,
        0,
        1
      );

    if (
      !W ||
      !H ||
      w < 0.12 ||
      h < 0.12 ||
      w * h < 0.025 ||
      x + w > 1.02 ||
      y + h > 1.02
    ) {
      return {
        ok: false,
        reason:
          'bbox_invalid',
        confidence:
          Number(
            p.confidence || 0
          )
      };
    }

    const mx = w * 0.012;
    const my = h * 0.012;

    const l =
      clamp(
        x - mx,
        0,
        1
      );

    const t =
      clamp(
        y - my,
        0,
        1
      );

    const rgt =
      clamp(
        x + w + mx,
        0,
        1
      );

    const bot =
      clamp(
        y + h + my,
        0,
        1
      );

    const left =
      Math.floor(
        l * W
      );

    const top =
      Math.floor(
        t * H
      );

    const width =
      Math.max(
        1,
        Math.min(
          W - left,
          Math.ceil(
            (rgt - l) * W
          )
        )
      );

    const height =
      Math.max(
        1,
        Math.min(
          H - top,
          Math.ceil(
            (bot - t) * H
          )
        )
      );

    const cropped =
      await sharp(image)
        .extract({
          left,
          top,
          width,
          height
        })
        .jpeg({
          quality: 95,
          chromaSubsampling:
            '4:4:4'
        })
        .toBuffer();

    return {
      ok: true,
      buffer: cropped,
      confidence:
        Number(
          p.confidence || 0
        ),
      bbox: {
        x,
        y,
        width: w,
        height: h
      },
      reason:
        p.reason ||
        'isolated'
    };
  } catch (e) {
    return {
      ok: false,
      reason:
        `isolation_failed: ${e.message}`,
      confidence: 0
    };
  }
}

async function isolateArtworkReferences(
  title,
  references
) {
  const checked =
    await Promise.all(
      references.map(
        async (ref, i) => ({
          ref,
          iso:
            await isolateArtworkReference(
              title,
              ref.buffer,
              i
            )
        })
      )
    );

  return checked
    .filter(
      x => x.iso.ok
    )
    .map(
      x => ({
        ...x.ref,
        originalBuffer:
          x.ref.buffer,
        buffer:
          x.iso.buffer,
        isolation: {
          isolated: true,
          confidence:
            x.iso.confidence,
          bbox:
            x.iso.bbox,
          reason:
            x.iso.reason
        }
      })
    );
}

function stableNumber(value) {
  return Number.parseInt(
    createHash('sha256')
      .update(
        String(
          value || ''
        )
      )
      .digest('hex')
      .slice(0, 8),
    16
  ) || 0;
}

async function getRecentSceneHistory(
  limit =
    RECENT_SCENE_HISTORY_LIMIT
) {
  const rows =
    await redis().lrange(
      sceneHistoryKey(),
      0,
      Math.max(
        0,
        limit - 1
      )
    );

  return (rows || [])
    .map(row => {
      if (
        row &&
        typeof row ===
          'object'
      ) {
        return row;
      }

      try {
        return JSON.parse(
          String(row)
        );
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

async function loadRecentGeneratedComparisons(
  limit =
    RECENT_QA_COMPARISON_LIMIT
) {
  const history =
    await getRecentSceneHistory(
      Math.max(
        limit * 4,
        limit
      )
    );

  const out = [];
  const seen =
    new Set();

  for (const item of history) {
    if (
      out.length >= limit
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
      seen.has(token)
    ) {
      continue;
    }

    const b64 =
      await redis().get(
        previewImageKey(
          token
        )
      );

    if (!b64) {
      continue;
    }

    out.push({
      scene_family:
        item.scene_family ||
        null,
      signature:
        item.signature ||
        item.decor_signature ||
        null,
      buffer:
        Buffer.from(
          String(b64),
          'base64'
        )
    });

    seen.add(token);
  }

  return out;
}

async function analyzeArtworkContext(
  title,
  references
) {
  const imgs =
    await Promise.all(
      references.map(
        x =>
          normalizeJpeg(
            x.buffer,
            1200,
            90
          )
      )
    );

  const ids =
    SCENE_FAMILIES.map(
      x => x.id
    );

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: [
      'subject',
      'style',
      'mood',
      'palette',
      'orientation',
      'recommended_scene_families',
      'must_preserve',
      'confidence'
    ],
    properties: {
      subject: {
        type: 'string'
      },
      style: {
        type: 'string'
      },
      mood: {
        type: 'string'
      },
      palette: {
        type: 'array',
        items: {
          type: 'string'
        },
        maxItems: 8
      },
      orientation: {
        type: 'string',
        enum: [
          'portrait',
          'landscape',
          'square',
          'unknown'
        ]
      },
      recommended_scene_families: {
        type: 'array',
        items: {
          type: 'string',
          enum: ids
        },
        minItems: 3,
        maxItems: 6
      },
      must_preserve: {
        type: 'array',
        items: {
          type: 'string'
        },
        maxItems: 10
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1
      }
    }
  };

  const content = [
    {
      type: 'input_text',
      text:
        `Analyze the isolated wall-art product, not any room.

Listing: ${title || ''}.

Describe subject/style/mood/palette/orientation, list must-preserve details, and recommend 3-6 fitting scene families.

Different artworks should not default to the same room.

Prefer neutral daylight.

Available families:
${SCENE_FAMILIES.map(
  x =>
    `${x.id}: ${x.description}`
).join('\n')}`
    },
    ...imgs.map(
      img => ({
        type: 'input_image',
        image_url:
          `data:image/jpeg;base64,${img.toString('base64')}`,
        detail: 'high'
      })
    )
  ];

  try {
    const r =
      await openai()
        .responses
        .create({
          model: QA_MODEL,
          store: false,
          input: [
            {
              role: 'user',
              content
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name:
                'artwork_context_v31',
              strict: true,
              schema
            }
          }
        });

    const p =
      JSON.parse(
        r.output_text ||
        '{}'
      );

    p.recommended_scene_families =
      (
        p.recommended_scene_families ||
        []
      ).filter(
        id =>
          ids.includes(id)
      );

    if (
      !p.recommended_scene_families
        .length
    ) {
      p.recommended_scene_families =
        ids;
    }

    return p;
  } catch (e) {
    return {
      subject:
        title ||
        'wall art',
      style: 'unknown',
      mood: 'unknown',
      palette: [],
      orientation:
        'unknown',
      recommended_scene_families:
        ids,
      must_preserve: [
        'exact artwork identity',
        'subject and composition',
        'orientation and color identity'
      ],
      confidence: 0
    };
  }
}

function chooseScenePlan({
  listingId,
  title,
  context,
  recent,
  excluded = []
}) {
  const all =
    SCENE_FAMILIES.map(
      x => x.id
    );

  const preferred =
    [
      ...new Set([
        ...(
          context
            ?.recommended_scene_families ||
          []
        ),
        ...all
      ])
    ].filter(
      x =>
        all.includes(x)
    );

  const recentIds =
    (recent || [])
      .map(
        x =>
          String(
            x.scene_family ||
            ''
          )
      )
      .filter(Boolean);

  const banned =
    new Set([
      ...recentIds.slice(
        0,
        5
      ),
      ...excluded
    ]);

  let choices =
    preferred.filter(
      x =>
        !banned.has(x)
    );

  if (!choices.length) {
    const counts =
      new Map(
        all.map(
          x => [
            x,
            0
          ]
        )
      );

    recentIds.forEach(
      x =>
        counts.set(
          x,
          (
            counts.get(x) ||
            0
          ) + 1
        )
    );

    const min =
      Math.min(
        ...preferred.map(
          x =>
            counts.get(x) ||
            0
        )
      );

    choices =
      preferred.filter(
        x =>
          (
            counts.get(x) ||
            0
          ) === min &&
          !excluded.includes(x)
      );
  }

  if (!choices.length) {
    choices = preferred;
  }

  const id =
    choices[
      stableNumber(
        `${listingId}:${title}:${Date.now()}`
      ) %
      choices.length
    ];

  const f =
    SCENE_FAMILIES.find(
      x => x.id === id
    ) ||
    SCENE_FAMILIES[0];

  return {
    scene_family: f.id,
    scene_label: f.label,
    scene_description:
      f.description,
    signature:
      f.signature,
    allowed:
      f.allowed,
    rule:
      f.rule,
    recent_scene_families:
      recentIds.slice(
        0,
        8
      ),
    recent_signatures: [
      ...new Set(
        (recent || [])
          .slice(0, 8)
          .map(
            x =>
              x.signature ||
              x.decor_signature
          )
          .filter(Boolean)
      )
    ],
    artwork_subject:
      context?.subject ||
      title ||
      'wall art',
    artwork_style:
      context?.style ||
      'unknown',
    mood:
      context?.mood ||
      'unknown',
    palette:
      context?.palette ||
      [],
    must_preserve:
      context?.must_preserve ||
      []
  };
}

function buildGenerationPrompt({
  title,
  reason,
  plan
}) {
  return `
Create a premium Etsy FIRST-IMAGE hero thumbnail for the exact WALL-ART PRODUCT in the supplied isolated reference image(s).

LISTING:
${title || ''}

REASON:
${reason}

CRITICAL PRODUCT-TRUTH RULE:
The reference input has been cropped to the artwork/canvas/frame.

Preserve that exact product identity, subject, composition, orientation, color identity, visible product text/signature and frame geometry.

Do not redesign, repaint, substitute, simplify, add or remove artwork content.

NEW SCENE PLAN:
Family: ${plan.scene_label}
Direction: ${plan.scene_description}
Allowed elements ONLY: ${JSON.stringify(plan.allowed)}
Layout rule: ${plan.rule}
Artwork subject/style/mood: ${plan.artwork_subject} / ${plan.artwork_style} / ${plan.mood}
Palette: ${JSON.stringify(plan.palette)}
Must preserve: ${JSON.stringify(plan.must_preserve)}

ZERO-TOLERANCE FORBIDDEN STAGING:
${HARD_FORBIDDEN.map(
  x => `- NO ${x}`
).join('\n')}

- NO wall-art-over-console composition.
- NO object directly below the artwork unless explicitly listed in allowed elements.
- NO substitute prop that recreates the old plant/vase/books/console mockup.
- If a forbidden prop would appear, leave empty architectural space instead.

ANTI-REPEAT:
Recent scene families: ${JSON.stringify(plan.recent_scene_families)}
Recent signatures: ${JSON.stringify(plan.recent_signatures)}
Current signature: ${plan.signature}

Do not reuse the same furniture layout, camera framing, wall/floor relationship or decorative rhythm.

PRESENTATION:
Artwork must be large and dominant, about 50-75% of useful composition where practical.

It must remain front-readable on mobile.

Use bright neutral daylight and realistic shadows.

Use neutral white, cream, pale stone, soft beige or soft grey room tones.

Warm colors may remain inside the artwork, but the surrounding room must not have an amber/yellow/orange cast.

No HDR, haze, dark cinematic exposure, clutter, fake glow or aggressive grading.

Square Etsy-ready composition.

Return only the finished image.
`.trim();
}

async function generateThumbnail({
  title,
  references,
  reason,
  plan,
  retryNote = ''
}) {
  const files =
    await Promise.all(
      references.map(
        async (ref, i) =>
          toFile(
            await normalizeJpeg(
              ref.buffer,
              1600,
              95
            ),
            `artwork-${i + 1}.jpg`,
            {
              type:
                'image/jpeg'
            }
          )
      )
    );

  const prompt =
    buildGenerationPrompt({
      title,
      reason,
      plan
    }) +
    (
      retryNote
        ? `

PREVIOUS ATTEMPT FAILED:
${retryNote}

Use the NEW scene family and correct every failure.

Never reintroduce a forbidden prop.`
        : ''
    );

  const r =
    await openai()
      .images
      .edit({
        model: IMAGE_MODEL,
        image: files,
        prompt,
        size: IMAGE_SIZE,
        quality:
          IMAGE_QUALITY
      });

  const b64 =
    r?.data?.[0]
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

async function strictStagingCheck(
  buffer,
  plan
) {
  const image =
    await normalizeJpeg(
      buffer,
      1200,
      92
    );

  const bools = [
    'potted_plant_or_planter',
    'vase_or_vessel',
    'flowers_or_branches',
    'books_or_magazines',
    'console_sideboard_credenza',
    'styled_shelf_or_tabletop',
    'generic_console_mockup',
    'artwork_too_small',
    'artwork_obscured_or_distorted',
    'warm_amber_room_cast',
    'scene_family_mismatch'
  ];

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: [
      ...bools,
      'confidence',
      'reason'
    ],
    properties:
      Object.fromEntries([
        ...bools.map(
          x => [
            x,
            {
              type:
                'boolean'
            }
          ]
        ),
        [
          'confidence',
          {
            type: 'number',
            minimum: 0,
            maximum: 1
          }
        ],
        [
          'reason',
          {
            type:
              'string'
          }
        ]
      ])
  };

  try {
    const r =
      await openai()
        .responses
        .create({
          model:
            COMPLIANCE_MODEL,
          store: false,
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text:
                    `ZERO-TOLERANCE visual compliance gate.

Chosen family:
${plan.scene_label}

Allowed elements:
${JSON.stringify(plan.allowed)}

Rule:
${plan.rule}

Set a forbidden field TRUE if visibly present.

If uncertain, choose TRUE.

Reject any:
- potted plant / planter / pot
- vase / vessel
- flowers / branches
- books / magazines
- console / sideboard / credenza
- styled shelf / tabletop
- generic wall-art-over-console scene
- artwork too small
- artwork obscured or distorted
- amber/yellow room cast
- scene-family mismatch

Warm colors inside the artwork do not count as room cast.

Do not excuse a forbidden object because the image looks attractive.`
                },
                {
                  type: 'input_image',
                  image_url:
                    `data:image/jpeg;base64,${image.toString('base64')}`,
                  detail: 'high'
                }
              ]
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name:
                'strict_staging_gate_v31',
              strict: true,
              schema
            }
          }
        });

    const p =
      JSON.parse(
        r.output_text ||
        '{}'
      );

    const forbidden =
      bools.filter(
        k =>
          p[k] === true
      );

    return {
      ...p,
      forbidden,
      passed:
        forbidden.length === 0 &&
        Number(
          p.confidence || 0
        ) >= 0.82
    };
  } catch (e) {
    return {
      passed: false,
      forbidden: [
        'compliance_check_failed'
      ],
      confidence: 0,
      reason:
        `Compliance check failed: ${e.message}`
    };
  }
}

async function qualityCheck({
  title,
  references,
  generatedBuffer,
  plan,
  recentGenerated,
  hardGate
}) {
  const refs =
    await Promise.all(
      references.map(
        x =>
          normalizeJpeg(
            x.buffer,
            1200,
            90
          )
      )
    );

  const gen =
    await normalizeJpeg(
      generatedBuffer,
      1200,
      90
    );

  const comparisons =
    await Promise.all(
      (recentGenerated || [])
        .map(
          async x => ({
            ...x,
            normalized:
              await normalizeJpeg(
                x.buffer,
                900,
                82
              )
          })
        )
    );

  const analysis =
    await analyzeImage(gen);

  const technical =
    analysis.brightness >= 82 &&
    analysis.shadow_percent <= 50 &&
    analysis.highlight_percent <= 18 &&
    analysis.contrast >= 24;

  const keys = [
    'pass',
    'same_product',
    'same_artwork_identity',
    'important_elements_preserved',
    'color_identity_preserved',
    'invented_product_content',
    'thumbnail_readable',
    'artwork_dominant',
    'scene_fit',
    'generic_mockup',
    'repeated_scene',
    'excessive_decor',
    'warm_room_cast',
    'invented_text_or_logo'
  ];

  const schema = {
    type: 'object',
    additionalProperties: false,
    required: [
      ...keys,
      'confidence',
      'reason'
    ],
    properties:
      Object.fromEntries([
        ...keys.map(
          x => [
            x,
            {
              type:
                'boolean'
            }
          ]
        ),
        [
          'confidence',
          {
            type: 'number',
            minimum: 0,
            maximum: 1
          }
        ],
        [
          'reason',
          {
            type:
              'string'
          }
        ]
      ])
  };

  const content = [
    {
      type: 'input_text',
      text:
        `Final independent QA for Etsy wall art.

Listing:
${title || ''}

Chosen scene:
${plan.scene_label}

Product-truth images first are isolated artwork/canvas/frame.

Recent generated heroes, if present, are only for staging repetition comparison.

Final candidate is last.

PASS only if:
- exact artwork identity is preserved
- content, colors and composition are faithful
- no invented product content
- no invented text/logo/watermark
- artwork is large and mobile-readable
- scene fits the selected family
- result is not generic
- architecture/furniture/camera/layout does not substantially repeat recent generated heroes
- decor is minimal
- room light is neutral

Be conservative.

The hard staging gate is separate and cannot be overridden.`
    },
    {
      type: 'input_text',
      text:
        'ISOLATED PRODUCT TRUTH:'
    },
    ...refs.map(
      x => ({
        type: 'input_image',
        image_url:
          `data:image/jpeg;base64,${x.toString('base64')}`,
        detail: 'high'
      })
    )
  ];

  if (comparisons.length) {
    content.push({
      type: 'input_text',
      text:
        'RECENT GENERATED HEROES — compare staging/layout only:'
    });

    for (
      const x of comparisons
    ) {
      content.push({
        type: 'input_text',
        text:
          `Recent family ${x.scene_family || 'unknown'}, signature ${x.signature || 'unknown'}`
      });

      content.push({
        type: 'input_image',
        image_url:
          `data:image/jpeg;base64,${x.normalized.toString('base64')}`,
        detail: 'low'
      });
    }
  }

  content.push({
    type: 'input_text',
    text:
      'FINAL CANDIDATE:'
  });

  content.push({
    type: 'input_image',
    image_url:
      `data:image/jpeg;base64,${gen.toString('base64')}`,
    detail: 'high'
  });

  let p;

  try {
    const r =
      await openai()
        .responses
        .create({
          model: QA_MODEL,
          store: false,
          input: [
            {
              role: 'user',
              content
            }
          ],
          text: {
            format: {
              type: 'json_schema',
              name:
                'thumbnail_qc_v31',
              strict: true,
              schema
            }
          }
        });

    p =
      JSON.parse(
        r.output_text ||
        '{}'
      );
  } catch (e) {
    p = {
      pass: false,
      same_product: false,
      same_artwork_identity: false,
      important_elements_preserved: false,
      color_identity_preserved: false,
      invented_product_content: true,
      thumbnail_readable: false,
      artwork_dominant: false,
      scene_fit: false,
      generic_mockup: true,
      repeated_scene: false,
      excessive_decor: true,
      warm_room_cast: true,
      invented_text_or_logo: true,
      confidence: 0,
      reason:
        `QA failed: ${e.message}`
    };
  }

  const semantic =
    p.pass === true &&
    p.same_product === true &&
    p.same_artwork_identity === true &&
    p.important_elements_preserved === true &&
    p.color_identity_preserved === true &&
    p.invented_product_content === false &&
    p.thumbnail_readable === true &&
    p.artwork_dominant === true &&
    p.scene_fit === true &&
    p.generic_mockup === false &&
    p.repeated_scene === false &&
    p.excessive_decor === false &&
    p.warm_room_cast === false &&
    p.invented_text_or_logo === false &&
    Number(
      p.confidence || 0
    ) >= 0.82;

  return {
    passed:
      hardGate?.passed === true &&
      technical &&
      semantic,
    hard_gate_passed:
      hardGate?.passed === true,
    hard_gate:
      hardGate,
    technical_passed:
      technical,
    semantic_passed:
      semantic,
    generated_analysis:
      analysis,
    scene_plan: {
      scene_family:
        plan.scene_family,
      scene_label:
        plan.scene_label,
      signature:
        plan.signature
    },
    semantic: p
  };
}

async function savePreview({
  listingId,
  title,
  sourceImageId,
  referenceImageIds,
  generatedBuffer,
  qc,
  reason,
  artworkContext,
  scenePlan,
  referenceIsolation
}) {
  const token =
    randomBytes(24)
      .toString(
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
    generatorVersion:
      WORKER_VERSION,
    listingId:
      String(listingId),
    title:
      title || null,
    sourceImageId:
      String(sourceImageId),
    referenceImageIds:
      referenceImageIds.map(
        String
      ),
    artworkContext,
    scenePlan,
    referenceIsolation,
    qc,
    reason,
    createdAt:
      Date.now()
  };

  await Promise.all([
    setJson(
      previewKey(token),
      meta,
      {
        ex:
          PREVIEW_TTL_SECONDS
      }
    ),
    redis().set(
      previewImageKey(token),
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
      String(listingId),
    scene_family:
      scenePlan.scene_family,
    signature:
      scenePlan.signature,
    artwork_subject:
      scenePlan.artwork_subject
  });

  return {
    ...meta,
    previewUrl:
      `${publicBase()}/preview/worker/${token}`
  };
}

async function loadPreview(token) {
  const meta =
    await getJson(
      previewKey(token)
    );

  const b64 =
    await redis().get(
      previewImageKey(token)
    );

  if (
    !meta ||
    !b64
  ) {
    const e =
      new Error(
        'Preview not found or expired'
      );
    e.status = 404;
    throw e;
  }

  return {
    ...meta,
    generatedBuffer:
      Buffer.from(
        String(b64),
        'base64'
      )
  };
}

async function deleteOldRank1IfSafe({
  listingId,
  oldImageId,
  replacementImageId
}) {
  const set =
    await getImageSet(
      listingId
    );

  const rank1 =
    set.images.find(
      x =>
        Number(x.rank) === 1
    ) ||
    set.images[0];

  if (
    String(
      getImageId(rank1)
    ) !==
    String(replacementImageId)
  ) {
    return {
      deleted: false,
      reason:
        'replacement_is_not_rank1'
    };
  }

  if (
    !set.images.some(
      x =>
        String(
          getImageId(x)
        ) ===
        String(oldImageId)
    )
  ) {
    return {
      deleted: false,
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
  } catch (e) {
    return {
      deleted: false,
      reason:
        'variation_safety_check_failed',
      detail:
        e.message
    };
  }

  if (
    (
      variationData?.results ||
      []
    ).some(
      x =>
        String(
          x?.image_id
        ) ===
        String(oldImageId)
    )
  ) {
    return {
      deleted: false,
      reason:
        'old_image_used_by_variation'
    };
  }

  await etsyRequest(
    `/shops/${await getShopId()}/listings/${listingId}/images/${oldImageId}`,
    {
      method: 'DELETE'
    }
  );

  const after =
    await getImageSet(
      listingId
    );

  const afterRank1 =
    after.images.find(
      x =>
        Number(x.rank) === 1
    ) ||
    after.images[0];

  return {
    deleted:
      !after.images.some(
        x =>
          String(
            getImageId(x)
          ) ===
          String(oldImageId)
      ),
    replacement_still_rank1:
      String(
        getImageId(afterRank1)
      ) ===
      String(replacementImageId)
  };
}

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
        preview.listingId
      );

    const before =
      await getImageSet(
        listingId
      );

    if (
      String(
        getImageId(
          before.rank1
        )
      ) !==
      String(
        preview.sourceImageId
      )
    ) {
      const e =
        new Error(
          'Rank 1 changed after preview was created. Generate a fresh preview.'
        );
      e.status = 409;
      throw e;
    }

    if (
      before.images.length >= 20
    ) {
      const e =
        new Error(
          'Listing already has 20 images. Safe upload-before-delete is blocked.'
        );
      e.status = 409;
      throw e;
    }

    if (
      preview?.qc?.passed !== true ||
      preview?.qc
        ?.hard_gate_passed !== true
    ) {
      const e =
        new Error(
          'Preview did not pass all quality gates'
        );
      e.status = 409;
      throw e;
    }

    const beforeIds =
      new Set(
        before.images
          .map(
            x =>
              String(
                getImageId(x)
              )
          )
          .filter(Boolean)
      );

    const up =
      await uploadListingImage({
        shopId:
          await getShopId(),
        listingId,
        imageBuffer:
          preview.generatedBuffer,
        filename:
          `vaelons-thumbnail-${listingId}.jpg`,
        contentType:
          'image/jpeg',
        rank: 1
      });

    uploadOccurred = true;

    const rec =
      Array.isArray(
        up?.results
      )
        ? up.results[0]
        : up;

    let uploadedId =
      getImageId(rec);

    let verified = null;

    for (
      let i = 0;
      i < 5;
      i++
    ) {
      if (i) {
        await sleep(900);
      }

      verified =
        await getImageSet(
          listingId
        );

      if (!uploadedId) {
        const added =
          verified.images.filter(
            x =>
              !beforeIds.has(
                String(
                  getImageId(x)
                )
              )
          );

        if (
          added.length === 1
        ) {
          uploadedId =
            getImageId(
              added[0]
            );
        }
      }

      const r1 =
        verified.images.find(
          x =>
            Number(x.rank) === 1
        ) ||
        verified.images[0];

      if (
        uploadedId &&
        String(
          getImageId(r1)
        ) ===
        String(uploadedId)
      ) {
        break;
      }
    }

    const finalR1 =
      verified?.images?.find(
        x =>
          Number(x.rank) === 1
      ) ||
      verified?.images?.[0] ||
      null;

    const ok =
      Boolean(
        uploadedId &&
        String(
          getImageId(finalR1)
        ) ===
        String(uploadedId)
      );

    let cleanup = {
      deleted: false,
      reason:
        'not_requested'
    };

    if (
      ok &&
      deleteOld
    ) {
      cleanup =
        await deleteOldRank1IfSafe({
          listingId,
          oldImageId:
            preview.sourceImageId,
          replacementImageId:
            uploadedId
        });
    }

    const result = {
      success: ok,
      listing_id:
        Number(listingId),
      old_rank1_image_id:
        preview.sourceImageId,
      uploaded_image_id:
        uploadedId || null,
      replacement_verified_as_rank1:
        ok,
      cleanup,
      etsy_modified: true
    };

    await setJson(
      stateKey(listingId),
      {
        status:
          ok
            ? 'published'
            : 'manual_attention',
        generatorVersion:
          WORKER_VERSION,
        sourceImageId:
          String(
            preview.sourceImageId
          ),
        uploadedImageId:
          uploadedId
            ? String(uploadedId)
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
  } catch (e) {
    if (uploadOccurred) {
      e.etsyModified = true;
    }

    throw e;
  }
}

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
      stateKey(listingId)
    );

  if (
    !force &&
    existing &&
    String(
      existing.sourceImageId ||
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
          Number(listingId),
        exact_title:
          exact?.title ||
          null,
        action: 'skipped',
        reason:
          'preview_already_ready_for_current_rank1',
        state: existing,
        etsy_modified: false
      };
    }

    if (
      existing.status ===
      'manual_attention'
    ) {
      return {
        listing_id:
          Number(listingId),
        exact_title:
          exact?.title ||
          null,
        action: 'blocked',
        reason:
          'manual_attention_required_before_retry',
        state: existing,
        etsy_modified: false
      };
    }

    if (
      existing.status ===
        'blocked_qa' &&
      Date.now() -
        Number(
          existing.checkedAt ||
          0
        ) <
        QA_RETRY_COOLDOWN_MS
    ) {
      return {
        listing_id:
          Number(listingId),
        exact_title:
          exact?.title ||
          null,
        action: 'skipped',
        reason:
          'qa_retry_cooldown',
        state: existing,
        etsy_modified: false
      };
    }

    if (
      existing.status ===
        'published' &&
      String(
        existing.uploadedImageId ||
        ''
      ) ===
      sourceImageId
    ) {
      return {
        listing_id:
          Number(listingId),
        exact_title:
          exact?.title ||
          null,
        action: 'keep',
        reason:
          'current_rank1_was_published_by_worker',
        state: existing,
        etsy_modified: false
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
      status: 'healthy',
      sourceImageId,
      checkedAt:
        Date.now(),
      rank1Score,
      rank1Analysis
    };

    await setJson(
      stateKey(listingId),
      state
    );

    return {
      listing_id:
        Number(listingId),
      exact_title:
        exact?.title ||
        null,
      action: 'keep',
      reason:
        'thumbnail_is_healthy',
      rank1_score:
        rank1Score,
      analysis:
        rank1Analysis,
      etsy_modified: false
    };
  }

  const selected =
    await selectReferences(
      exact?.title || '',
      imageSet
    );

  const references =
    await isolateArtworkReferences(
      exact?.title || '',
      selected
    );

  const referenceImageIds =
    selected.map(
      x =>
        getImageId(x.image)
    );

  if (!references.length) {
    const state = {
      status:
        'blocked_qa',
      generatorVersion:
        WORKER_VERSION,
      sourceImageId,
      checkedAt:
        Date.now(),
      rank1Score,
      rank1Analysis,
      referenceImageIds:
        referenceImageIds.map(
          String
        ),
      qc: {
        passed: false,
        reason:
          'artwork_isolation_failed'
      }
    };

    await setJson(
      stateKey(listingId),
      state
    );

    return {
      listing_id:
        Number(listingId),
      exact_title:
        exact?.title ||
        null,
      action: 'blocked',
      generator_version:
        WORKER_VERSION,
      reason:
        'artwork_isolation_failed',
      rank1_score:
        rank1Score,
      etsy_modified: false
    };
  }

  const recent =
    await getRecentSceneHistory();

  const context =
    await analyzeArtworkContext(
      exact?.title || '',
      references
    );

  const recentGenerated =
    await loadRecentGeneratedComparisons();

  const attempted = [];

  let plan =
    chooseScenePlan({
      listingId,
      title:
        exact?.title || '',
      context,
      recent,
      excluded:
        attempted
    });

  let generated = null;
  let qc = null;

  for (
    let attempt = 1;
    attempt <=
      STRICT_MAX_ATTEMPTS;
    attempt++
  ) {
    attempted.push(
      plan.scene_family
    );

    const retry =
      attempt > 1
        ? (
            qc?.hard_gate
              ?.reason ||
            qc?.semantic
              ?.reason ||
            'Previous candidate failed. Remove every forbidden prop and use the new scene.'
          )
        : '';

    generated =
      await generateThumbnail({
        title:
          exact?.title || '',
        references,
        reason:
          isNew
            ? 'New listing needs a fresh hero thumbnail.'
            : `Current thumbnail score ${rank1Score}/100 needs improvement.`,
        plan,
        retryNote:
          retry
      });

    const hardGate =
      await strictStagingCheck(
        generated,
        plan
      );

    if (!hardGate.passed) {
      qc = {
        passed: false,
        hard_gate_passed:
          false,
        hard_gate:
          hardGate,
        technical_passed:
          null,
        semantic_passed:
          null,
        generated_analysis:
          await analyzeImage(
            generated
          ),
        scene_plan: {
          scene_family:
            plan.scene_family,
          scene_label:
            plan.scene_label,
          signature:
            plan.signature
        },
        semantic: null
      };
    } else {
      qc =
        await qualityCheck({
          title:
            exact?.title || '',
          references,
          generatedBuffer:
            generated,
          plan,
          recentGenerated,
          hardGate
        });
    }

    if (qc.passed) {
      break;
    }

    if (
      attempt <
      STRICT_MAX_ATTEMPTS
    ) {
      plan =
        chooseScenePlan({
          listingId,
          title:
            exact?.title || '',
          context,
          recent,
          excluded:
            attempted
        });
    }
  }

  const isolation =
    references.map(
      x =>
        x.isolation
    );

  if (!qc?.passed) {
    const state = {
      status:
        'blocked_qa',
      generatorVersion:
        WORKER_VERSION,
      sourceImageId,
      checkedAt:
        Date.now(),
      rank1Score,
      rank1Analysis,
      referenceImageIds:
        referenceImageIds.map(
          String
        ),
      artworkContext:
        context,
      referenceIsolation:
        isolation,
      scenePlan:
        plan,
      qc
    };

    await setJson(
      stateKey(listingId),
      state
    );

    return {
      listing_id:
        Number(listingId),
      exact_title:
        exact?.title ||
        null,
      action: 'blocked',
      generator_version:
        WORKER_VERSION,
      reason:
        'generated_thumbnail_failed_quality_gate',
      rank1_score:
        rank1Score,
      reference_image_ids:
        referenceImageIds,
      artwork_context:
        context,
      reference_isolation:
        isolation,
      scene_plan:
        plan,
      qc,
      etsy_modified: false
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
      reason,
      artworkContext:
        context,
      scenePlan:
        plan,
      referenceIsolation:
        isolation
    });

  await setJson(
    stateKey(listingId),
    {
      status:
        'preview_ready',
      generatorVersion:
        WORKER_VERSION,
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
      artworkContext:
        context,
      referenceIsolation:
        isolation,
      scenePlan:
        plan,
      qc
    }
  );

  return {
    listing_id:
      Number(listingId),
    exact_title:
      exact?.title ||
      null,
    action:
      'preview_ready',
    generator_version:
      WORKER_VERSION,
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
    artwork_context:
      context,
    reference_isolation:
      isolation,
    scene_plan:
      plan,
    approval_required:
      'ONAYLIYORUM',
    etsy_modified: false
  };
}

async function fetchAllActiveListings() {
  const shopId =
    await getShopId();

  const results = [];

  let offset = 0;
  let total =
    Infinity;

  while (
    offset < total
  ) {
    const data =
      await etsyRequest(
        `/shops/${shopId}/listings`,
        {
          params: {
            state: 'active',
            limit: 100,
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

    results.push(...page);

    if (
      !page.length ||
      page.length < 100
    ) {
      break;
    }

    offset +=
      page.length;
  }

  return results;
}

async function acquireWorkerLock() {
  const token =
    randomBytes(12)
      .toString('hex');

  return (
    await redis().set(
      `${PREFIX}:lock`,
      token,
      {
        nx: true,
        ex:
          LOCK_TTL_SECONDS
      }
    )
  )
    ? token
    : null;
}

async function releaseWorkerLock(token) {
  if (
    String(
      await redis().get(
        `${PREFIX}:lock`
      ) ||
      ''
    ) ===
    String(token)
  ) {
    await redis().del(
      `${PREFIX}:lock`
    );
  }
}

async function runWorker() {
  const lock =
    await acquireWorkerLock();

  if (!lock) {
    return {
      ok: false,
      skipped: true,
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

    if (!initialized) {
      if (listings.length) {
        await redis().sadd(
          `${PREFIX}:seen`,
          ...listings.map(
            x =>
              String(
                x.listing_id
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
        const x of listings
      ) {
        const id =
          String(
            x.listing_id
          );

        if (
          !await redis().sismember(
            `${PREFIX}:seen`,
            id
          )
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
          x => [
            String(
              x.listing_id
            ),
            x
          ]
        )
      );

    const selected = [];
    const selectedIds =
      new Set();

    for (
      const id of
      (
        await redis().smembers(
          `${PREFIX}:pending-new`
        )
      ).map(String)
    ) {
      if (
        selected.length >=
        WORKER_BATCH_SIZE
      ) {
        break;
      }

      const listing =
        byId.get(id);

      if (listing) {
        selected.push({
          listing,
          reason:
            'new_listing'
        });

        selectedIds.add(id);
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
      ) || 0;

    if (listings.length) {
      cursor %=
        listings.length;
    }

    let examined = 0;

    while (
      selected.length <
        WORKER_BATCH_SIZE &&
      examined <
        listings.length
    ) {
      const listing =
        listings[
          (
            cursor +
            examined
          ) %
          listings.length
        ];

      const id =
        String(
          listing.listing_id
        );

      if (
        !selectedIds.has(id)
      ) {
        selected.push({
          listing,
          reason:
            'rolling_scan'
        });

        selectedIds.add(id);
      }

      examined++;
    }

    if (listings.length) {
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

    const results = [];

    for (
      const item of selected
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

        results.push(result);

        if (
          item.reason ===
            'new_listing' &&
          result.action !==
            'error'
        ) {
          await redis().srem(
            `${PREFIX}:pending-new`,
            String(
              item.listing
                .listing_id
            )
          );
        }
      } catch (e) {
        results.push({
          listing_id:
            Number(
              item.listing
                .listing_id
            ),
          exact_title:
            item.listing
              .title ||
            null,
          action: 'error',
          reason:
            item.reason,
          error:
            e.message,
          etsy_modified:
            e.etsyModified ===
            true
        });
      }
    }

    return {
      ok: true,
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
      lock
    );
  }
}

app.get(
  '/health',
  (_req, res) =>
    res.json({
      ok: true,
      service:
        'vaelons-ai-thumbnail-worker',
      version:
        WORKER_VERSION,
      worker_mode:
        WORKER_MODE,
      image_model:
        IMAGE_MODEL,
      qa_model:
        QA_MODEL,
      compliance_model:
        COMPLIANCE_MODEL,
      openai_key_source:
        'VAELONS_OPENAI_API_KEY',
      approval_required:
        'ONAYLIYORUM',
      safe_replace_order:
        'isolate artwork -> choose non-repeating scene -> generate -> hard staging gate -> identity QA -> preview -> ONAYLIYORUM -> upload -> verify rank1 -> delete old -> verify',
      artwork_reference_isolation:
        true,
      hard_staging_gate:
        true,
      anti_repeat_memory:
        true,
      max_generation_attempts:
        STRICT_MAX_ATTEMPTS
    })
);

app.get(
  '/oauth/etsy/start',
  (req, res) => {
    try {
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

      res.cookie(
        'etsy_oauth',
        sealJson({
          state,
          verifier,
          ts:
            Date.now()
        }),
        {
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
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
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        error:
          e.message
      });
    }
  }
);

app.get(
  '/oauth/etsy/callback',
  async (req, res) => {
    try {
      if (req.query.error) {
        return res
          .status(400)
          .send(
            `Etsy authorization failed: ${req.query.error_description || req.query.error}`
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
            method: 'POST',
            headers: {
              'content-type':
                'application/x-www-form-urlencoded; charset=utf-8'
            },
            body
          }
        );

      const token =
        await tokenRes.json();

      if (!tokenRes.ok) {
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

      const capsule =
        sealJson({
          refresh_token:
            token.refresh_token,
          shop_id:
            shopId
        });

      res.clearCookie(
        'etsy_oauth'
      );

      res.type('html')
        .send(
          `<!doctype html>
<meta charset="utf-8">
<title>VAELONS Etsy Connected</title>
<h2>VAELONS Etsy bağlantısı doğrulandı.</h2>
<p>Aşağıdaki şifreli değeri <b>ETSY_TOKEN_CAPSULE</b> olarak Vercel Environment Variables bölümüne ekleyin.</p>
<textarea style="width:100%;height:150px" readonly onclick="this.select()">${capsule}</textarea>`
        );
    } catch (e) {
      res.status(
        e.status || 500
      ).json({
        error:
          e.message,
        details:
          e.details ||
          null
      });
    }
  }
);

app.get(
  '/preview/worker/:token',
  async (req, res) => {
    try {
      const token =
        String(
          req.params.token ||
          ''
        );

      const meta =
        await getJson(
          previewKey(token)
        );

      const b64 =
        await redis().get(
          previewImageKey(token)
        );

      if (
        !meta ||
        !b64
      ) {
        return res
          .status(404)
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
          String(b64),
          'base64'
        )
      );
    } catch (e) {
      res.status(500)
        .send(
          e.message
        );
    }
  }
);

app.use(
  '/api/worker',
  workerAuth
);

app.get(
  '/api/worker/status',
  async (_req, res, next) => {
    try {
      res.json({
        service:
          'vaelons-ai-thumbnail-worker',
        version:
          WORKER_VERSION,
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
          ) || 0,
        auto_delete_old_rank1:
          AUTO_DELETE_OLD_RANK1,
        openai_key_source:
          'VAELONS_OPENAI_API_KEY',
        approval_required:
          'ONAYLIYORUM',
        artwork_reference_isolation:
          true,
        hard_staging_gate:
          true,
        anti_repeat_memory:
          true,
        max_generation_attempts:
          STRICT_MAX_ATTEMPTS,
        recent_scene_count:
          (
            await getRecentSceneHistory()
          ).length,
        etsy_modified: false
      });
    } catch (e) {
      next(e);
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
    } catch (e) {
      next(e);
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
      const id =
        asListingId(
          req.params.listingId
        );

      const listing =
        await etsyRequest(
          `/listings/${id}`
        );

      res.json(
        await prepareListing(
          listing,
          {
            reason: 'manual',
            force:
              req.body?.force ===
              true
          }
        )
      );
    } catch (e) {
      next(e);
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
      const id =
        asListingId(
          req.params.listingId
        );

      res.json({
        listing_id:
          Number(id),
        state:
          await getJson(
            stateKey(id)
          ),
        etsy_modified:
          false
      });
    } catch (e) {
      next(e);
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
      const id =
        asListingId(
          req.params.listingId
        );

      if (
        String(
          req.body?.approval ||
          ''
        ).trim() !==
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
        await loadPreview(
          String(
            req.body
              ?.preview_token ||
            ''
          ).trim()
        );

      if (
        String(
          preview.listingId
        ) !== id
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
    } catch (e) {
      next(e);
    }
  }
);

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
    } catch (e) {
      next(e);
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
    } catch (e) {
      next(e);
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
          req.query.limit ||
          25,
          1,
          100
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
        String(
          req.query.state ||
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
    } catch (e) {
      next(e);
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
      const id =
        asListingId(
          req.params.listingId
        );

      res.json(
        await etsyRequest(
          `/listings/${id}`
        )
      );
    } catch (e) {
      next(e);
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
      const id =
        asListingId(
          req.params.listingId
        );

      const data =
        await getListingImages(id);

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
          x =>
            Number(x.rank) === 1
        ) ||
        ordered[0] ||
        null;

      res.json({
        listing_id:
          Number(id),
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
            x => ({
              image_id:
                getImageId(x),
              rank:
                Number(
                  x?.rank ??
                  0
                ),
              image_url:
                getImageUrl(x)
            })
          ),
        results:
          ordered,
        etsy_modified:
          false
      });
    } catch (e) {
      next(e);
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
    let modified = false;

    try {
      const id =
        asListingId(
          req.params.listingId
        );

      if (
        String(
          req.body?.approval ||
          ''
        ).trim() !==
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
        refs.length !== 1 ||
        !refs[0]
          ?.download_link
      ) {
        return res
          .status(400)
          .json({
            error:
              'Exactly one valid image file reference is required',
            etsy_modified:
              false
          });
      }

      const before =
        await getListingImages(id);

      if (
        (
          before?.results ||
          []
        ).length >= 20
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

      const requestedRank =
        Number(
          req.body?.rank
        );

      const rank =
        Number.isInteger(
          requestedRank
        ) &&
        requestedRank > 0
          ? requestedRank
          : (
              before?.results ||
              []
            ).length + 1;

      const result =
        await uploadListingImage({
          shopId:
            await getShopId(),
          listingId: id,
          imageBuffer:
            await downloadImage(
              refs[0]
                .download_link
            ),
          filename:
            refs[0].name ||
            `vaelons-${id}-image.jpg`,
          contentType:
            refs[0]
              .mime_type ||
            'image/jpeg',
          rank,
          overwrite: false,
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

      modified = true;

      const verified =
        await getListingImages(id);

      res.json({
        success: true,
        listing_id:
          Number(id),
        upload_result:
          result,
        image_count:
          (
            verified?.results ||
            []
          ).length,
        images:
          verified?.results ||
          [],
        etsy_modified: true
      });
    } catch (e) {
      e.etsyModified =
        modified;
      next(e);
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
    let modified = false;

    try {
      const id =
        asListingId(
          req.params.listingId
        );

      const imageId =
        asListingId(
          req.params.imageId
        );

      if (
        String(
          req.body?.approval ||
          ''
        ).trim() !==
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
          req.body?.rank
        );

      if (
        !Number.isInteger(rank) ||
        rank < 1
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
          listingId: id,
          listingImageId:
            imageId,
          rank
        });

      modified = true;

      res.json({
        ...result,
        etsy_modified:
          true
      });
    } catch (e) {
      e.etsyModified =
        modified;
      next(e);
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
    let modified = false;

    try {
      const id =
        asListingId(
          req.params.listingId
        );

      const imageId =
        asListingId(
          req.params.imageId
        );

      if (
        String(
          req.body?.approval ||
          ''
        ).trim() !==
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
          listingId: id,
          listingImageId:
            imageId,
          verify: true
        });

      modified =
        result?.deleted === true;

      res.json({
        ...result,
        etsy_modified:
          modified
      });
    } catch (e) {
      e.etsyModified =
        modified;
      next(e);
    }
  }
);

app.use(
  (
    error,
    _req,
    res,
    _next
  ) => {
    console.error(error);

    res.status(
      error.status || 500
    ).json({
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

if (!process.env.VERCEL) {
  const port =
    Number(
      process.env.PORT ||
      3000
    );

  app.listen(
    port,
    () =>
      console.log(
        `VAELONS AI Thumbnail Worker v${WORKER_VERSION} listening on :${port}`
      )
  );
}
