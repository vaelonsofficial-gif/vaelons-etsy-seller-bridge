import express from 'express';

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
  getTokenStatus
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

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function publicBase() {
  return required('PUBLIC_BASE_URL').replace(/\/$/, '');
}

function clampInt(value, min, max) {
  const n = Number(value);
  const safe = Number.isFinite(n) ? Math.round(n) : min;
  return Math.max(min, Math.min(max, safe));
}

function asListingId(value) {
  const id = String(value ?? '').trim();

  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    const error = new Error('Invalid listingId');
    error.status = 400;
    throw error;
  }

  return id;
}

function parseCookies(req) {
  const result = {};

  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');

    if (idx > -1) {
      result[part.slice(0, idx).trim()] = decodeURIComponent(
        part.slice(idx + 1).trim()
      );
    }
  }

  return result;
}

function bridgeAuth(req, res, next) {
  const auth = req.get('authorization') || '';
  const key = process.env.BRIDGE_API_KEY || '';

  if (!key || auth !== `Bearer ${key}`) {
    return res.status(401).json({
      error: 'unauthorized',
      etsy_modified: false
    });
  }

  next();
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'vaelons-seo-manager',
    version: '4.0.0',
    mode: 'seo_only',
    thumbnail_worker: false,
    backend_openai_required_for_seo: false,
    approval_required: 'ONAYLIYORUM',
    rollback_approval_required: 'GERI_AL ONAYLIYORUM',
    etsy_modified: false
  });
});

app.get('/oauth/etsy/start', (req, res) => {
  try {
    if (req.query.setup_secret !== required('SETUP_SECRET')) {
      return res.status(401).send('Invalid setup secret.');
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

    const url = new URL('https://www.etsy.com/oauth/connect');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', etsyApiKeyForOAuth());
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'listings_r listings_w shops_r shops_w');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    res.redirect(url.toString());
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      details: error.details || null,
      etsy_modified: false
    });
  }
});

app.get('/oauth/etsy/callback', async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send(
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

    const tokenRes = await fetch(
      'https://api.etsy.com/v3/public/oauth/token',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
        },
        body
      }
    );

    const token = await tokenRes.json();

    if (!tokenRes.ok) {
      return res
        .status(400)
        .send(`Token exchange failed: ${JSON.stringify(token)}`);
    }

    await setInitialToken(token);
    const shopId = await getShopId();
    const encryptedCapsule = sealJson({
      refresh_token: token.refresh_token,
      shop_id: shopId
    });

    res.clearCookie('etsy_oauth');
    res.type('html').send(`
<!doctype html>
<meta charset="utf-8">
<title>VAELONS Etsy Connected</title>
<h2>VAELONS Etsy bağlantısı doğrulandı.</h2>
<p>Aşağıdaki şifreli değeri <b>ETSY_TOKEN_CAPSULE</b> olarak Vercel Environment Variables bölümüne ekleyin.</p>
<textarea style="width:100%;height:150px" readonly onclick="this.select()">${encryptedCapsule}</textarea>
    `);
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      details: error.details || null,
      etsy_modified: false
    });
  }
});

app.use('/api', bridgeAuth);

app.get('/api/manager/status', async (_req, res, next) => {
  try {
    res.json({
      ok: true,
      manager_api: '2.0.0',
      mode: 'seo_only',
      thumbnail_worker: false,
      backend_openai_required_for_seo: false,
      etsy: await getTokenStatus(),
      approval_required: 'ONAYLIYORUM',
      rollback_approval_required: 'GERI_AL ONAYLIYORUM',
      etsy_modified: false
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/manager/bootstrap', async (req, res, next) => {
  const startedAt = Date.now();

  try {
    const limit = clampInt(req.query.limit || 100, 1, 100);
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const state = String(req.query.state || 'active');
    const shopId = await getShopId();

    const [etsy, listings] = await Promise.all([
      getTokenStatus(),
      etsyRequest(`/shops/${shopId}/listings`, {
        params: {
          limit,
          offset,
          state
        }
      })
    ]);

    res.json({
      ok: true,
      manager_api: '2.0.0',
      mode: 'seo_only',
      thumbnail_worker: false,
      backend_openai_required_for_seo: false,
      duration_ms: Date.now() - startedAt,
      etsy,
      listings: {
        state,
        limit,
        offset,
        total_count: Number(listings?.count ?? 0),
        page_count: Array.isArray(listings?.results)
          ? listings.results.length
          : 0,
        results: Array.isArray(listings?.results)
          ? listings.results
          : []
      },
      etsy_modified: false
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/token-status', async (_req, res, next) => {
  try {
    res.json(await getTokenStatus());
  } catch (error) {
    next(error);
  }
});

app.get('/api/shop', async (_req, res, next) => {
  try {
    res.json(await etsyRequest(`/shops/${await getShopId()}`));
  } catch (error) {
    next(error);
  }
});

app.get('/api/listings', async (req, res, next) => {
  try {
    const limit = clampInt(req.query.limit || 25, 1, 100);
    const offset = Math.max(0, Number(req.query.offset || 0) || 0);
    const state = String(req.query.state || 'active');

    res.json(
      await etsyRequest(`/shops/${await getShopId()}/listings`, {
        params: {
          limit,
          offset,
          state
        }
      })
    );
  } catch (error) {
    next(error);
  }
});

app.get('/api/listings/:listingId', async (req, res, next) => {
  try {
    const listingId = asListingId(req.params.listingId);
    res.json(await etsyRequest(`/listings/${listingId}`));
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error('VAELONS SEO manager error:', error);

  res.status(error.status || 500).json({
    error: error.message || 'internal_error',
    details: error.details || null,
    etsy_modified: error.etsyModified === true
  });
});

export default app;

if (!process.env.VERCEL) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => {
    console.log(`VAELONS SEO Manager v4.0.0 listening on :${port}`);
  });
}
