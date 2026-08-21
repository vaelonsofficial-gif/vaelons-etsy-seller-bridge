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
  return getShopId();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getRank1(images) {
  if (!Array.isArray(images) || images.length === 0) return null;
  return (
    images.find((img) => Number(img.rank) === 1) ||
    [...images].sort(
      (a, b) => Number(a.rank || 999) - Number(b.rank || 999)
    )[0]
  );
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

function getImageId(image) {
  return image?.listing_image_id || image?.image_id || null;
}

async function downloadImage(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const err = new Error(`Could not download Etsy image (${response.status})`);
    err.status = 502;
    throw err;
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!contentType.startsWith('image/')) {
    const err = new Error('Downloaded Etsy resource is not an image');
    err.status = 502;
    throw err;
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType
  };
}

async function analyzeImageBuffer(buffer) {
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
  if (brightness < 70) darknessLabel = 'very_dark';
  else if (brightness < 95) darknessLabel = 'dark';
  else if (brightness < 120) darknessLabel = 'slightly_dark';

  return {
    width: metadata.width ?? null,
    height: metadata.height ?? null,
    brightness,
    contrast,
    darknessLabel
  };
}

function buildRepairRecipe(brightness) {
  const deficit = Math.max(0, 105 - Number(brightness || 0));
  return {
    gain: Number(clamp(1 + deficit / 400, 1, 1.18).toFixed(3)),
    lift: Math.round(clamp(deficit * 0.6, 0, 38))
  };
}

async function applyRepair(buffer, { gain, lift }) {
  const safeGain = clamp(Number(gain) || 1, 1, 1.25);
  const safeLift = clamp(Number(lift) || 0, 0, 45);

  return sharp(buffer)
    .linear(safeGain, safeLift)
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

function previewSignature({ listingId, imageId, gain, lift, exp }) {
  const payload = `${listingId}.${imageId}.${gain}.${lift}.${exp}`;
  return createHmac('sha256', required('BRIDGE_API_KEY'))
    .update(payload)
    .digest('hex');
}

function secureEqual(a, b) {
  const aa = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'vaelons-etsy-seller-bridge' });
});

app.get('/oauth/etsy/start', (req, res) => {
  if (req.query.setup_secret !== required('SETUP_SECRET')) {
    return res.status(401).send('Invalid setup secret.');
  }

  const state = randomBase64Url(24);
  const verifier = randomBase64Url(48);
  const challenge = pkceChallenge(verifier);
  const redirectUri = `${publicBase()}/oauth/etsy/callback`;
  const capsule = sealJson({ state, verifier, ts: Date.now() });

  res.cookie('etsy_oauth', capsule, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000
  });

  const url = new URL('https://www.etsy.com/oauth/connect');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', etsyApiKeyForOAuth());
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'listings_r listings_w shops_r shops_w');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  res.redirect(url.toString());
});

app.get('/oauth/etsy/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res
        .status(400)
        .send(
          `Etsy authorization failed: ${
            req.query.error_description || req.query.error
          }`
        );
    }

    const cookie = parseCookies(req).etsy_oauth;
    if (!cookie) {
      return res.status(400).send('OAuth session expired. Start again.');
    }

    const flow = openJson(cookie);
    if (
      !req.query.state ||
      req.query.state !== flow.state ||
      Date.now() - flow.ts > 10 * 60 * 1000
    ) {
      return res.status(400).send('Invalid OAuth state.');
    }

    const redirectUri = `${publicBase()}/oauth/etsy/callback`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: etsyApiKeyForOAuth(),
      redirect_uri: redirectUri,
      code: String(req.query.code || ''),
      code_verifier: flow.verifier
    });

    const tokenRes = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
      },
      body
    });

    const token = await tokenRes.json();
    if (!tokenRes.ok) {
      return res
        .status(400)
        .send(`Token exchange failed: ${JSON.stringify(token)}`);
    }

    await setInitialToken(token);

    const shopId = await getShopId();
    await etsyRequest(`/shops/${shopId}/listings`, {
      params: { limit: 1 }
    });

    const capsule = sealJson({
      refresh_token: token.refresh_token,
      shop_id: shopId
    });

    res.clearCookie('etsy_oauth');
    res.type('html').send(`<!doctype html>
<meta charset="utf-8">
<title>VAELONS Etsy Connected</title>
<style>
body{font-family:system-ui;max-width:800px;margin:60px auto;padding:0 20px;line-height:1.5}
code,textarea{width:100%;word-break:break-all}
textarea{height:150px}
</style>
<h2>VAELONS Etsy Seller bağlantısı doğrulandı.</h2>
<p>Son güvenli adım: aşağıdaki şifreli token kapsülünü Vercel Environment Variables bölümüne <b>ETSY_TOKEN_CAPSULE</b> adıyla ekleyin.</p>
<textarea readonly onclick="this.select()">${capsule}</textarea>
<p>Production + Preview seçin, kaydedin ve Redeploy yapın. Bu değeri gizli tutun.</p>`);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message,
      details: err.details || null
    });
  }
});

// Public, signed, short-lived visual preview. It never writes to Etsy.
app.get('/preview/listings/:listingId/thumbnail', async (req, res, next) => {
  try {
    const listingId = String(req.params.listingId);
    const imageId = String(req.query.image_id || '');
    const gain = String(req.query.gain || '1');
    const lift = String(req.query.lift || '0');
    const exp = Number(req.query.exp || 0);
    const sig = String(req.query.sig || '');

    if (!imageId || !exp || Date.now() > exp) {
      return res.status(403).send('Preview link expired or invalid.');
    }

    const expected = previewSignature({ listingId, imageId, gain, lift, exp });
    if (!secureEqual(sig, expected)) {
      return res.status(403).send('Invalid preview signature.');
    }

    const imagesData = await getListingImages(listingId);
    const rank1 = getRank1(imagesData?.results || []);

    if (!rank1 || String(getImageId(rank1)) !== imageId) {
      return res.status(409).send('The listing rank 1 image has changed.');
    }

    const imageUrl = getImageUrl(rank1);
    if (!imageUrl) return res.status(404).send('No usable image URL found.');

    const { buffer } = await downloadImage(imageUrl);
    const repaired = await applyRepair(buffer, {
      gain: Number(gain),
      lift: Number(lift)
    });

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="vaelons-${listingId}-thumbnail-preview.jpg"`
    );
    res.send(repaired);
  } catch (err) {
    next(err);
  }
});

app.use('/api', bridgeAuth);

app.get('/api/token-status', async (_req, res, next) => {
  try {
    res.json(await getTokenStatus());
  } catch (err) {
    next(err);
  }
});

app.get('/api/shop', async (_req, res, next) => {
  try {
    res.json(await etsyRequest(`/shops/${await sid()}`));
  } catch (err) {
    next(err);
  }
});

app.patch('/api/shop', async (req, res, next) => {
  try {
    const allowed = [
      'title',
      'announcement',
      'sale_message',
      'digital_sale_message',
      'policy_additional'
    ];

    const body = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => allowed.includes(key))
    );

    if (!Object.keys(body).length) {
      return res.status(400).json({ error: 'No allowed shop fields provided.' });
    }

    res.json(
      await etsyRequest(`/shops/${await sid()}`, {
        method: 'PUT',
        body
      })
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/listings', async (req, res, next) => {
  try {
    const limit = clamp(Number(req.query.limit || 25), 1, 25);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const state = String(req.query.state || 'active');

    const data = await etsyRequest(`/shops/${await sid()}/listings`, {
      params: { limit, offset, state }
    });

    res.json({
      count: data?.count ?? 0,
      offset,
      limit,
      results: (data?.results || []).map((listing) => ({
        listing_id: listing.listing_id,
        title: listing.title,
        state: listing.state,
        created_timestamp:
          listing.original_creation_timestamp ??
          listing.creation_timestamp ??
          listing.created_timestamp ??
          null
      }))
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/listings/:listingId', async (req, res, next) => {
  try {
    res.json(
      await etsyRequest(`/listings/${encodeURIComponent(req.params.listingId)}`)
    );
  } catch (err) {
    next(err);
  }
});

app.patch('/api/listings/:listingId', async (req, res, next) => {
  try {
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

    const body = Object.fromEntries(
      Object.entries(req.body || {}).filter(([key]) => allowed.includes(key))
    );

    if (!Object.keys(body).length) {
      return res
        .status(400)
        .json({ error: 'No allowed listing fields provided.' });
    }

    res.json(
      await etsyRequest(
        `/shops/${await sid()}/listings/${encodeURIComponent(
          req.params.listingId
        )}`,
        { method: 'PATCH', body }
      )
    );
  } catch (err) {
    next(err);
  }
});

app.get('/api/listings/:listingId/images', async (req, res, next) => {
  try {
    res.json(await getListingImages(req.params.listingId));
  } catch (err) {
    next(err);
  }
});

app.post('/api/listings/:listingId/images', async (req, res, next) => {
  try {
    const refs = req.body?.openaiFileIdRefs;

    if (!Array.isArray(refs) || refs.length !== 1) {
      return res.status(400).json({
        error: 'Exactly one image file is required'
      });
    }

    const fileRef = refs[0];
    if (
      !fileRef ||
      typeof fileRef !== 'object' ||
      !fileRef.download_link
    ) {
      return res.status(400).json({
        error: 'Valid OpenAI file reference with download_link is required'
      });
    }

    const fileUrl = new URL(fileRef.download_link);
    if (fileUrl.protocol !== 'https:') {
      return res.status(400).json({
        error: 'Image download link must use HTTPS'
      });
    }

    const response = await fetch(fileRef.download_link);
    if (!response.ok) {
      return res.status(400).json({
        error: `Could not download image (${response.status})`
      });
    }

    const contentType =
      fileRef.mime_type ||
      response.headers.get('content-type') ||
      'image/jpeg';

    if (!contentType.startsWith('image/')) {
      return res.status(400).json({ error: 'Uploaded file must be an image' });
    }

    const imageBuffer = Buffer.from(await response.arrayBuffer());
    if (imageBuffer.length > 20 * 1024 * 1024) {
      return res.status(413).json({ error: 'Image exceeds 20 MB limit' });
    }

    const data = await uploadListingImage({
      shopId: await sid(),
      listingId: req.params.listingId,
      imageBuffer,
      filename: fileRef.name || 'image.jpg',
      contentType
    });

    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.get('/api/listings/:listingId/thumbnail-analysis', async (req, res, next) => {
  try {
    const imagesData = await getListingImages(req.params.listingId);
    const rank1 = getRank1(imagesData?.results || []);

    if (!rank1) {
      return res.status(404).json({ error: 'No listing images found' });
    }

    const imageUrl = getImageUrl(rank1);
    if (!imageUrl) {
      return res.status(404).json({ error: 'No usable image URL found' });
    }

    const { buffer } = await downloadImage(imageUrl);
    const analysis = await analyzeImageBuffer(buffer);

    res.json({
      listing_id: Number(req.params.listingId),
      image_id: getImageId(rank1),
      rank: rank1.rank ?? null,
      image_url: imageUrl,
      width: analysis.width,
      height: analysis.height,
      brightness_0_255: analysis.brightness,
      contrast_stdev: analysis.contrast,
      darkness_label: analysis.darknessLabel
    });
  } catch (err) {
    next(err);
  }
});

// Returns JSON metadata only. GPT Actions cannot return images/videos as openaiFileResponse.
app.get('/api/listings/:listingId/rank1-file', async (req, res, next) => {
  try {
    const imagesData = await getListingImages(req.params.listingId);
    const rank1 = getRank1(imagesData?.results || []);

    if (!rank1) {
      return res.status(404).json({ error: 'No listing images found' });
    }

    const imageUrl = getImageUrl(rank1);
    if (!imageUrl) {
      return res.status(404).json({ error: 'No usable rank 1 image URL found' });
    }

    res.json({
      listing_id: Number(req.params.listingId),
      image_id: getImageId(rank1),
      rank: rank1.rank ?? null,
      image_url: imageUrl
    });
  } catch (err) {
    next(err);
  }
});

// Generates a signed, short-lived preview URL for a deterministic brightness repair.
app.get('/api/listings/:listingId/thumbnail-preview', async (req, res, next) => {
  try {
    const listingId = String(req.params.listingId);
    const listing = await etsyRequest(`/listings/${encodeURIComponent(listingId)}`);
    const imagesData = await getListingImages(listingId);
    const rank1 = getRank1(imagesData?.results || []);

    if (!rank1) {
      return res.status(404).json({ error: 'No listing images found' });
    }

    const imageUrl = getImageUrl(rank1);
    const imageId = getImageId(rank1);
    if (!imageUrl || !imageId) {
      return res.status(404).json({ error: 'No usable rank 1 image found' });
    }

    const { buffer } = await downloadImage(imageUrl);
    const before = await analyzeImageBuffer(buffer);
    const recipe = buildRepairRecipe(before.brightness);
    const repaired = await applyRepair(buffer, recipe);
    const after = await analyzeImageBuffer(repaired);

    const exp = Date.now() + 15 * 60 * 1000;
    const sig = previewSignature({
      listingId,
      imageId,
      gain: recipe.gain,
      lift: recipe.lift,
      exp
    });

    const url = new URL(`${publicBase()}/preview/listings/${listingId}/thumbnail`);
    url.searchParams.set('image_id', String(imageId));
    url.searchParams.set('gain', String(recipe.gain));
    url.searchParams.set('lift', String(recipe.lift));
    url.searchParams.set('exp', String(exp));
    url.searchParams.set('sig', sig);

    res.json({
      listing_id: Number(listingId),
      title: listing?.title ?? null,
      current_rank1_image_id: imageId,
      current_rank1_image_url: imageUrl,
      before: {
        brightness_0_255: before.brightness,
        contrast_stdev: before.contrast,
        darkness_label: before.darknessLabel
      },
      proposed_recipe: recipe,
      predicted_preview: {
        brightness_0_255: after.brightness,
        contrast_stdev: after.contrast,
        darkness_label: after.darknessLabel
      },
      preview_url: url.toString(),
      preview_expires_at_ms: exp,
      note: 'Preview changes pixel brightness only; it does not invent or replace artwork content.'
    });
  } catch (err) {
    next(err);
  }
});

// Uploads the exact deterministic repair only after explicit user approval.
app.post('/api/listings/:listingId/thumbnail-repair', async (req, res, next) => {
  try {
    const listingId = String(req.params.listingId);
    const approval = String(req.body?.approval || '');
    const expectedTitle = String(req.body?.expected_title || '');
    const expectedImageId = String(req.body?.expected_rank1_image_id || '');
    const gain = Number(req.body?.gain);
    const lift = Number(req.body?.lift);

    if (approval !== 'ONAYLIYORUM') {
      return res.status(400).json({
        error: 'Explicit approval phrase ONAYLIYORUM is required'
      });
    }

    if (!expectedTitle || !expectedImageId) {
      return res.status(400).json({
        error: 'expected_title and expected_rank1_image_id are required'
      });
    }

    if (!Number.isFinite(gain) || !Number.isFinite(lift)) {
      return res.status(400).json({ error: 'Valid gain and lift are required' });
    }

    const listing = await etsyRequest(`/listings/${encodeURIComponent(listingId)}`);
    if (String(listing?.title || '') !== expectedTitle) {
      return res.status(409).json({
        error: 'Listing title changed or does not match approval',
        current_title: listing?.title ?? null
      });
    }

    const imagesData = await getListingImages(listingId);
    const rank1 = getRank1(imagesData?.results || []);
    const currentImageId = rank1 ? String(getImageId(rank1) || '') : '';

    if (!rank1 || currentImageId !== expectedImageId) {
      return res.status(409).json({
        error: 'Rank 1 image changed after approval',
        current_rank1_image_id: currentImageId || null
      });
    }

    const imageUrl = getImageUrl(rank1);
    if (!imageUrl) {
      return res.status(404).json({ error: 'No usable rank 1 image URL found' });
    }

    const { buffer } = await downloadImage(imageUrl);
    const before = await analyzeImageBuffer(buffer);
    const repaired = await applyRepair(buffer, { gain, lift });
    const after = await analyzeImageBuffer(repaired);

    const uploadResult = await uploadListingImage({
      shopId: await sid(),
      listingId,
      imageBuffer: repaired,
      filename: `vaelons-${listingId}-thumbnail-repair.jpg`,
      contentType: 'image/jpeg'
    });

    const verifiedImages = await getListingImages(listingId);

    res.json({
      ok: true,
      listing_id: Number(listingId),
      title: listing.title,
      source_rank1_image_id: getImageId(rank1),
      before: {
        brightness_0_255: before.brightness,
        contrast_stdev: before.contrast,
        darkness_label: before.darknessLabel
      },
      applied_recipe: {
        gain: clamp(gain, 1, 1.25),
        lift: clamp(lift, 0, 45)
      },
      repaired: {
        brightness_0_255: after.brightness,
        contrast_stdev: after.contrast,
        darkness_label: after.darknessLabel
      },
      upload_result: uploadResult,
      images_after_upload: verifiedImages?.results || []
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/sections', async (_req, res, next) => {
  try {
    res.json(await etsyRequest(`/shops/${await sid()}/sections`));
  } catch (err) {
    next(err);
  }
});

app.post('/api/sections', async (req, res, next) => {
  try {
    if (!req.body?.title) {
      return res.status(400).json({ error: 'title is required' });
    }

    res.json(
      await etsyRequest(`/shops/${await sid()}/sections`, {
        method: 'POST',
        body: { title: req.body.title }
      })
    );
  } catch (err) {
    next(err);
  }
});

app.put('/api/sections/:sectionId', async (req, res, next) => {
  try {
    if (!req.body?.title) {
      return res.status(400).json({ error: 'title is required' });
    }

    res.json(
      await etsyRequest(
        `/shops/${await sid()}/sections/${encodeURIComponent(
          req.params.sectionId
        )}`,
        {
          method: 'PUT',
          body: { title: req.body.title }
        }
      )
    );
  } catch (err) {
    next(err);
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'internal_error',
    details: err.details || null
  });
});

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`VAELONS Etsy Seller bridge listening on :${port}`);
  });
}
