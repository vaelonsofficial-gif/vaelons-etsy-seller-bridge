import express from 'express';
import multer from 'multer';
import { randomBase64Url, pkceChallenge, sealJson, openJson } from './crypto.js';
import { etsyRequest, getShopId, etsyApiKeyForOAuth, setInitialToken, getTokenStatus, getListingImages, uploadListingImage } from './etsy.js';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function bridgeAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  if (auth !== `Bearer ${required('BRIDGE_API_KEY')}`) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function publicBase() { return required('PUBLIC_BASE_URL').replace(/\/$/, ''); }

app.get('/health', (_req, res) => res.json({ ok: true, service: 'vaelons-etsy-seller-bridge' }));

app.get('/oauth/etsy/start', (req, res) => {
  if (req.query.setup_secret !== required('SETUP_SECRET')) return res.status(401).send('Invalid setup secret.');
  const state = randomBase64Url(24);
  const verifier = randomBase64Url(48);
  const challenge = pkceChallenge(verifier);
  const redirectUri = `${publicBase()}/oauth/etsy/callback`;
  const capsule = sealJson({ state, verifier, ts: Date.now() });
  res.cookie('etsy_oauth', capsule, { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
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

function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) result[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return result;
}

app.get('/oauth/etsy/callback', async (req, res) => {
  try {
    if (req.query.error) return res.status(400).send(`Etsy authorization failed: ${req.query.error_description || req.query.error}`);
    const cookie = parseCookies(req).etsy_oauth;
    if (!cookie) return res.status(400).send('OAuth session expired. Start again.');
    const flow = openJson(cookie);
    if (!req.query.state || req.query.state !== flow.state || Date.now() - flow.ts > 10 * 60 * 1000) return res.status(400).send('Invalid OAuth state.');
    const redirectUri = `${publicBase()}/oauth/etsy/callback`;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: etsyApiKeyForOAuth(),
      redirect_uri: redirectUri,
      code: String(req.query.code || ''),
      code_verifier: flow.verifier
    });
    const tokenRes = await fetch('https://api.etsy.com/v3/public/oauth/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body
    });
    const token = await tokenRes.json();
    if (!tokenRes.ok) return res.status(400).send(`Token exchange failed: ${JSON.stringify(token)}`);
    await setInitialToken(token);
    // Verify the token can read this exact VAELONS shop's private listing collection.
    const sid = await getShopId();
    await etsyRequest(`/application/shops/${sid}/listings`, { params: { limit: 1 } });
    const capsule = sealJson({ refresh_token: token.refresh_token, shop_id: sid });
    res.clearCookie('etsy_oauth');
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>VAELONS Etsy Connected</title><style>body{font-family:system-ui;max-width:800px;margin:60px auto;padding:0 20px;line-height:1.5}code,textarea{width:100%;word-break:break-all}textarea{height:150px}</style><h2>VAELONS Etsy Seller bağlantısı doğrulandı.</h2><p>Son güvenli adım: aşağıdaki şifreli token kapsülünü Vercel Environment Variables bölümüne <b>ETSY_TOKEN_CAPSULE</b> adıyla ekleyin. Bu değer Etsy refresh tokenını AES-256-GCM ile şifrelenmiş halde içerir.</p><textarea readonly onclick="this.select()">${capsule}</textarea><p>Production + Preview seçin, kaydedin ve Redeploy yapın. Bu kapsül ham Etsy tokenı değildir; yine de gizli tutun.</p>`);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.details || null });
  }
});

app.use('/api', bridgeAuth);

async function sid() { return await getShopId(); }

app.get('/api/token-status', async (_req, res) => res.json(await getTokenStatus()));

app.get('/api/shop', async (_req, res, next) => {
  try { res.json(await etsyRequest(`/application/shops/${await sid()}`)); } catch (e) { next(e); }
});

app.patch('/api/shop', async (req, res, next) => {
  try {
    const allowed = ['title', 'announcement', 'sale_message', 'digital_sale_message', 'policy_additional'];
    const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(body).length) return res.status(400).json({ error: 'No allowed shop fields provided.' });
    res.json(await etsyRequest(`/application/shops/${await sid()}`, { method: 'PUT', body }));
  } catch (e) { next(e); }
});

app.get('/api/listings', async (req, res, next) => {
  try {
    const params = { limit: Math.min(Number(req.query.limit || 100), 100), offset: Number(req.query.offset || 0), state: req.query.state || undefined };
    res.json(await etsyRequest(`/application/shops/${await sid()}/listings`, { params }));
  } catch (e) { next(e); }
});

app.get('/api/listings/:listingId', async (req, res, next) => {
  try { res.json(await etsyRequest(`/application/listings/${req.params.listingId}`)); } catch (e) { next(e); }
});

app.patch('/api/listings/:listingId', async (req, res, next) => {
  try {
    const allowed = ['title', 'description', 'tags', 'materials', 'shop_section_id', 'section_id', 'state', 'is_customizable', 'is_personalizable', 'personalization_is_required', 'personalization_char_count_max', 'personalization_instructions'];
    const body = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(body).length) return res.status(400).json({ error: 'No allowed listing fields provided.' });
    res.json(await etsyRequest(`/application/shops/${await sid()}/listings/${req.params.listingId}`, { method: 'PATCH', body }));
  } catch (e) { next(e); }
});


app.get('/api/listings/:listingId/images', bridgeAuth, async (req, res, next) => {
  try {
    const data = await getListingImages(req.params.listingId);
    res.json(data);
  } catch (err) {
    next(err);
  }
});

app.post('/api/listings/:listingId/images', bridgeAuth, async (req, res, next) => {
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

    const imageResponse = await fetch(fileRef.download_link);

    if (!imageResponse.ok) {
      return res.status(400).json({
        error: `Could not download image (${imageResponse.status})`
      });
    }

    const imageBuffer = Buffer.from(
      await imageResponse.arrayBuffer()
    );

    const contentType =
      fileRef.mime_type ||
      imageResponse.headers.get('content-type') ||
      'image/jpeg';

    if (!contentType.startsWith('image/')) {
      return res.status(400).json({
        error: 'Uploaded file must be an image'
      });
    }

    const shopId = await getShopId();

    const data = await uploadListingImage({
      shopId,
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
app.post('/api/sections', async (req, res, next) => {
  try {
    if (!req.body?.title) return res.status(400).json({ error: 'title is required' });
    res.json(await etsyRequest(`/application/shops/${await sid()}/sections`, { method: 'POST', body: { title: req.body.title } }));
  } catch (e) { next(e); }
});

app.put('/api/sections/:sectionId', async (req, res, next) => {
  try {
    if (!req.body?.title) return res.status(400).json({ error: 'title is required' });
    res.json(await etsyRequest(`/application/shops/${await sid()}/sections/${req.params.sectionId}`, { method: 'PUT', body: { title: req.body.title } }));
  } catch (e) { next(e); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'internal_error', details: err.details || null });
});

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`VAELONS Etsy Seller bridge listening on :${port}`));
}
