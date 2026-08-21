import express from 'express';
import sharp from 'sharp';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomBase64Url, pkceChallenge, sealJson, openJson } from './crypto.js';
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

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function publicBase() {
  return required('PUBLIC_BASE_URL').replace(/\/$/, '');
}

function bridgeAuth(req, res, next) {
  const auth = req.get('authorization') || '';

  if (auth !== `Bearer ${required('BRIDGE_API_KEY')}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  next();
}

function parseCookies(req) {
  const result = {};

  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');

    if (idx > -1) {
      result[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim()
      );
    }
  }

  return result;
}

async function sid() {
  return String(await getShopId());
}

function asListingId(value) {
  const id = String(value || '').trim();

  if (!/^\d+$/.test(id)) {
    const err = new Error('Invalid listingId');
    err.status = 400;
    throw err;
  }

  return id;
}

function asSectionId(value) {
  const id = String(value || '').trim();

  if (!/^\d+$/.test(id)) {
    const err = new Error('Invalid sectionId');
    err.status = 400;
    throw err;
  }

  return id;
}

function getImageId(image) {
  return image?.listing_image_id ?? image?.image_id ?? null;
}

function getImageUrl(image) {
  return (
    image?.url_fullxfull ||
    image?.url_570xN ||
    image?.url_300x300 ||
    image?.url_75x75 ||
    null
  );
}

async function getRank1Image(listingId) {
  const data = await getListingImages(listingId);
  const images = Array.isArray(data?.results) ? data.results : [];

  if (!images.length) {
    const err = new Error('No listing images found');
    err.status = 404;
    throw err;
  }

  const rank1 =
    images.find((img) => Number(img.rank) === 1) ||
    [...images].sort(
      (a, b) => Number(a.rank ?? 9999) - Number(b.rank ?? 9999)
    )[0];

  const imageUrl = getImageUrl(rank1);

  if (!imageUrl) {
    const err = new Error('No usable rank 1 image URL found');
    err.status = 404;
    throw err;
  }

  return {
    image: rank1,
    imageId: getImageId(rank1),
    imageUrl
  };
}

async function downloadImage(url) {
  const parsed = new URL(url);

  if (parsed.protocol !== 'https:') {
    const err = new Error('Image URL must use HTTPS');
    err.status = 400;
    throw err;
  }

  const response = await fetch(url);

  if (!response.ok) {
    const err = new Error(`Could not download image (${response.status})`);
    err.status = 502;
    throw err;
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > 20 * 1024 * 1024) {
    const err = new Error('Image is larger than 20 MB');
    err.status = 413;
    throw err;
  }

  return {
    buffer,
    contentType: response.headers.get('content-type') || 'image/jpeg'
  };
}

async function analyzeImage(buffer) {
  const metadata = await sharp(buffer).metadata();

  const stats = await sharp(buffer)
    .resize({
      width: 400,
      height: 400,
      fit: 'inside',
      withoutEnlargement: true
    })
    .greyscale()
    .stats();

  const brightness = Math.round(stats.channels?.[0]?.mean ?? 0);
  const contrast = Math.round(stats.channels?.[0]?.stdev ?? 0);

  let darknessLabel = 'good';

  if (brightness < 70) {
    darknessLabel = 'very_dark';
  } else if (brightness < 95) {
    darknessLabel = 'dark';
  } else if (brightness < 120) {
    darknessLabel = 'slightly_dark';
  }

  return {
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    brightness_0_255: brightness,
    contrast_stdev: contrast,
    darkness_label: darknessLabel
  };
}

function normalizeTargetBrightness(value) {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 110;
  }

  return Math.max(80, Math.min(140, Math.round(parsed)));
}

async function repairImage(buffer, transform) {
  return sharp(buffer)
    .linear(transform.gain, transform.offset)
    .jpeg({
      quality: 95,
      chromaSubsampling: '4:4:4'
    })
    .toBuffer();
}

async function findRepairTransform(
  buffer,
  currentBrightness,
  requestedTarget = 110
) {
  const target = normalizeTargetBrightness(requestedTarget);
  const gain = 1.06;

  let low = 0;
  let high = 120;

  let best = {
    gain,
    offset: 0,
    target,
    achieved: currentBrightness,
    distance: Math.abs(target - currentBrightness)
  };

  for (let i = 0; i < 8; i += 1) {
    const offset = Math.round((low + high) / 2);

    const candidate = await repairImage(buffer, {
      gain,
      offset
    });

    const analysis = await analyzeImage(candidate);
    const achieved = analysis.brightness_0_255;
    const distance = Math.abs(target - achieved);

    if (distance < best.distance) {
      best = {
        gain,
        offset,
        target,
        achieved,
        distance
      };
    }

    if (achieved < target) {
      low = offset + 1;
    } else {
      high = offset - 1;
    }
  }

  return best;
}

function signRepairPayload(payload) {
  const encoded = Buffer
    .from(JSON.stringify(payload))
    .toString('base64url');

  const signature = createHmac(
    'sha256',
    required('BRIDGE_API_KEY')
  )
    .update(encoded)
    .digest('base64url');

  return `${encoded}.${signature}`;
}

function verifyRepairToken(token) {
  const [encoded, signature] = String(token || '').split('.');

  if (!encoded || !signature) {
    const err = new Error('Invalid repair token');
    err.status = 400;
    throw err;
  }

  const expected = createHmac(
    'sha256',
    required('BRIDGE_API_KEY')
  )
    .update(encoded)
    .digest('base64url');

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (
    a.length !== b.length ||
    !timingSafeEqual(a, b)
  ) {
    const err = new Error('Invalid repair token signature');
    err.status = 400;
    throw err;
  }

  const payload = JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8')
  );

  if (!payload?.exp || Date.now() > payload.exp) {
    const err = new Error('Repair preview expired');
    err.status = 410;
    throw err;
  }

  return payload;
}


// ==================================================
// HEALTH
// ==================================================

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vaelons-etsy-seller-bridge'
  });
});


// ==================================================
// OAUTH
// ==================================================

app.get('/oauth/etsy/start', (req, res) => {
  if (
    req.query.setup_secret !==
    required('SETUP_SECRET')
  ) {
    return res
      .status(401)
      .send('Invalid setup secret.');
  }

  const state = randomBase64Url(24);
  const verifier = randomBase64Url(48);
  const challenge = pkceChallenge(verifier);
  const redirectUri = `${publicBase()}/oauth/etsy/callback`;

  const capsule = sealJson({
    state,
    verifier,
    ts: Date.now()
  });

  res.cookie('etsy_oauth', capsule, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000
  });

  const url = new URL(
    'https://www.etsy.com/oauth/connect'
  );

  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', etsyApiKeyForOAuth());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set(
    'scope',
    'listings_r listings_w shops_r shops_w'
  );
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  res.redirect(url.toString());
});


app.get(
  '/oauth/etsy/callback',
  async (req, res) => {
    try {
      if (req.query.error) {
        return res.status(400).send(
          `Etsy authorization failed: ${
            req.query.error_description ||
            req.query.error
          }`
        );
      }

      const cookie = parseCookies(req).etsy_oauth;

      if (!cookie) {
        return res
          .status(400)
          .send(
            'OAuth session expired. Start again.'
          );
      }

      const flow = openJson(cookie);

      if (
        !req.query.state ||
        req.query.state !== flow.state ||
        Date.now() - flow.ts >
          10 * 60 * 1000
      ) {
        return res
          .status(400)
          .send('Invalid OAuth state.');
      }

      const redirectUri =
        `${publicBase()}/oauth/etsy/callback`;

      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: etsyApiKeyForOAuth(),
        redirect_uri: redirectUri,
        code: String(req.query.code || ''),
        code_verifier: flow.verifier
      });

      const tokenRes = await fetch(
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

      const token = await tokenRes.json();

      if (!tokenRes.ok) {
        return res
          .status(400)
          .send(
            `Token exchange failed: ${JSON.stringify(token)}`
          );
      }

      await setInitialToken(token);

      const shopId = await getShopId();

      await etsyRequest(
        `/shops/${shopId}/listings`,
        {
          params: {
            limit: 1,
            state: 'active'
          }
        }
      );

      const encryptedCapsule = sealJson({
        refresh_token: token.refresh_token,
        shop_id: shopId
      });

      res.clearCookie('etsy_oauth');

      res.type('html').send(`
<!doctype html>
<meta charset="utf-8">
<title>VAELONS Etsy Connected</title>

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

<h2>VAELONS Etsy Seller bağlantısı doğrulandı.</h2>

<p>
Aşağıdaki şifreli değeri Vercel Environment Variables bölümüne
<b>ETSY_TOKEN_CAPSULE</b> adıyla ekleyin.
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

      res.status(
        err.status || 500
      ).json({
        error: err.message,
        details: err.details || null
      });
    }
  }
);


// ==================================================
// PUBLIC PREVIEW
// ==================================================

app.get(
  '/preview/thumbnail-repair/:token',
  async (req, res) => {
    try {
      const payload =
        verifyRepairToken(
          req.params.token
        );

      const listingId =
        asListingId(
          payload.listingId
        );

      const rank1 =
        await getRank1Image(
          listingId
        );

      if (
        String(rank1.imageId) !==
        String(payload.sourceImageId)
      ) {
        return res
          .status(409)
          .json({
            error:
              'Current rank 1 image changed after preview was created'
          });
      }

      const { buffer } =
        await downloadImage(
          rank1.imageUrl
        );

      const repaired =
        await repairImage(
          buffer,
          {
            gain:
              Number(payload.gain),

            offset:
              Number(payload.offset)
          }
        );

      res.setHeader(
        'content-type',
        'image/jpeg'
      );

      res.setHeader(
        'content-disposition',
        'inline; filename="thumbnail-repair-preview.jpg"'
      );

      res.setHeader(
        'cache-control',
        'private, max-age=300'
      );

      res.send(repaired);

    } catch (err) {
      console.error(err);

      res.status(
        err.status || 400
      ).json({
        error: err.message
      });
    }
  }
);


// ==================================================
// API AUTH
// ==================================================

app.use(
  '/api',
  bridgeAuth
);


// ==================================================
// TOKEN STATUS
// ==================================================

app.get(
  '/api/token-status',
  async (_req, res, next) => {
    try {
      res.json(
        await getTokenStatus()
      );
    } catch (err) {
      next(err);
    }
  }
);


// ==================================================
// SHOP
// ==================================================

app.get(
  '/api/shop',
  async (_req, res, next) => {
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
  async (req, res, next) => {
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
            req.body || {}
          ).filter(
            ([key]) =>
              allowed.includes(key)
          )
        );

      if (
        !Object.keys(body).length
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
            method: 'PUT',
            body
          }
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


// ==================================================
// LISTINGS
// ==================================================

app.get(
  '/api/listings',
  async (req, res, next) => {
    try {
      const limit =
        Math.max(
          1,
          Math.min(
            Number(
              req.query.limit || 25
            ),
            25
          )
        );

      const offset =
        Math.max(
          0,
          Number(
            req.query.offset || 0
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
          data?.count ?? 0,

        offset,
        limit,

        results:
          (
            data?.results || []
          ).map(
            (listing) => ({
              listing_id:
                listing.listing_id,

              title:
                listing.title,

              state:
                listing.state,

              created_timestamp:
                listing.original_creation_timestamp ??
                listing.creation_timestamp ??
                listing.created_timestamp ??
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
  async (req, res, next) => {
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
  async (req, res, next) => {
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
            req.body || {}
          ).filter(
            ([key]) =>
              allowed.includes(key)
          )
        );

      if (
        !Object.keys(body).length
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
            method: 'PATCH',
            body
          }
        )
      );

    } catch (err) {
      next(err);
    }
  }
);


// ==================================================
// LISTING IMAGES
// ==================================================

app.get(
  '/api/listings/:listingId/images',
  async (req, res, next) => {
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
  async (req, res, next) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const refs =
        req.body?.openaiFileIdRefs;

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
        typeof fileRef !== 'object' ||
        typeof fileRef.download_link !==
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


// ==================================================
// THUMBNAIL ANALYSIS
// ==================================================

app.get(
  '/api/listings/:listingId/thumbnail-analysis',
  async (req, res, next) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const rank1 =
        await getRank1Image(
          listingId
        );

      const { buffer } =
        await downloadImage(
          rank1.imageUrl
        );

      const analysis =
        await analyzeImage(
          buffer
        );

      res.json({
        listing_id:
          Number(listingId),

        image_id:
          rank1.imageId,

        rank:
          rank1.image.rank ??
          null,

        image_url:
          rank1.imageUrl,

        ...analysis
      });

    } catch (err) {
      next(err);
    }
  }
);


// ==================================================
// THUMBNAIL REPAIR PREVIEW
// READ ONLY
// ==================================================

app.post(
  '/api/listings/:listingId/thumbnail-repair/preview',
  async (req, res, next) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const listing =
        await etsyRequest(
          `/listings/${listingId}`
        );

      const rank1 =
        await getRank1Image(
          listingId
        );

      const { buffer } =
        await downloadImage(
          rank1.imageUrl
        );

      const before =
        await analyzeImage(
          buffer
        );

      const targetBrightness =
        normalizeTargetBrightness(
          req.body?.target_brightness ??
          110
        );

      const transform =
        await findRepairTransform(
          buffer,
          before.brightness_0_255,
          targetBrightness
        );

      const repaired =
        await repairImage(
          buffer,
          transform
        );

      const after =
        await analyzeImage(
          repaired
        );

      const token =
        signRepairPayload({
          listingId,

          sourceImageId:
            String(
              rank1.imageId
            ),

          gain:
            transform.gain,

          offset:
            transform.offset,

          target:
            transform.target,

          exp:
            Date.now() +
            15 * 60 * 1000
        });

      const fileName =
        `etsy-${listingId}-thumbnail-repair.jpg`;

      res.json({
        listing_id:
          Number(listingId),

        exact_title:
          listing?.title ??
          null,

        source_image_id:
          rank1.imageId,

        source_image_url:
          rank1.imageUrl,

        preview_file_name:
          fileName,

        preview_url:
          `${publicBase()}/preview/thumbnail-repair/${token}`,

        before,

        after,

        repair: {
          type:
            'brightness_only',

          target_brightness:
            transform.target,

          achieved_brightness:
            after.brightness_0_255,

          gain:
            transform.gain,

          offset:
            transform.offset,

          artwork_content_changed:
            false
        },

        preview_token:
          token,

        expires_in_seconds:
          900,

        etsy_modified:
          false
      });

    } catch (err) {
      next(err);
    }
  }
);


// ==================================================
// THUMBNAIL REPAIR APPLY
// REQUIRES ONAYLIYORUM
// ==================================================

app.post(
  '/api/listings/:listingId/thumbnail-repair/apply',
  async (req, res, next) => {
    try {
      const listingId =
        asListingId(
          req.params.listingId
        );

      const approval =
        String(
          req.body?.approval || ''
        ).trim();

      const previewToken =
        String(
          req.body?.preview_token || ''
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
        verifyRepairToken(
          previewToken
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

      const rank1 =
        await getRank1Image(
          listingId
        );

      if (
        String(rank1.imageId) !==
        String(
          payload.sourceImageId
        )
      ) {
        return res
          .status(409)
          .json({
            error:
              'Current rank 1 image changed after approval preview; approval must be reconfirmed'
          });
      }

      const { buffer } =
        await downloadImage(
          rank1.imageUrl
        );

      const before =
        await analyzeImage(
          buffer
        );

      const repaired =
        await repairImage(
          buffer,
          {
            gain:
              Number(
                payload.gain
              ),

            offset:
              Number(
                payload.offset
              )
          }
        );

      const after =
        await analyzeImage(
          repaired
        );

      const uploadResult =
        await uploadListingImage({
          shopId:
            await sid(),

          listingId,

          imageBuffer:
            repaired,

          filename:
            `etsy-${listingId}-thumbnail-repair.jpg`,

          contentType:
            'image/jpeg'
        });

      const postImagesData =
        await getListingImages(
          listingId
        );

      const compactImages =
        (
          postImagesData?.results ||
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

      res.json({
        success: true,

        exact_title:
          listing?.title ??
          null,

        listing_id:
          Number(listingId),

        source_image_id:
          rank1.imageId,

        source_image_url:
          rank1.imageUrl,

        uploaded_image_id:
          uploadResult?.listing_image_id ??
          uploadResult?.image_id ??
          null,

        returned_rank:
          uploadResult?.rank ??
          null,

        before,

        after,

        existing_images_deleted:
          false,

        listing_fields_changed:
          false,

        current_images:
          compactImages
      });

    } catch (err) {
      next(err);
    }
  }
);


// ==================================================
// SECTIONS
// ==================================================

app.get(
  '/api/sections',
  async (_req, res, next) => {
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
  async (req, res, next) => {
    try {
      const title =
        String(
          req.body?.title || ''
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
            method: 'POST',
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
  async (req, res, next) => {
    try {
      const sectionId =
        asSectionId(
          req.params.sectionId
        );

      const title =
        String(
          req.body?.title || ''
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
            method: 'PUT',

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


// ==================================================
// ERROR HANDLER
// ==================================================

app.use(
  (err, _req, res, _next) => {
    console.error(err);

    res.status(
      err.status || 500
    ).json({
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


if (!process.env.VERCEL) {
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
