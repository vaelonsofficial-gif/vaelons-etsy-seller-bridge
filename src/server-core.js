import crypto from 'node:crypto';
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

import {
  TARGET_PRICE,
  TARGET_VARIATION,
  scanRolledCanvas13x18,
  updateRolledCanvas13x18
} from './price-manager.js';

import {
  bridgeVariationTemplates,
  bridgePreviewVariation,
  bridgeApplyVariation
} from './render-price-bridge.js';

import {
  getVariationIntelligenceStatus,
  scanVariationIntelligence,
  getListingVariationIntelligence,
  evaluateListingProfit
} from './variation-intelligence.js';

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
  return String(
    process.env.PUBLIC_BASE_URL ||
    'https://vaelons-etsy-seller-bridge-x2bh.vercel.app'
  ).replace(/\/$/, '');
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

const RENDER_PRICE_BRIDGE_TOKEN_HASH =
  'b8926bd052244448b80ef05d16f583bafbe08653a0c9a98cd90057a150168a0e';

function renderPriceBridgeAuth(req, res, next) {
  const auth = String(req.get('authorization') || '');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';

  if (!token) {
    return res.status(401).json({
      error: 'unauthorized',
      etsy_modified: false
    });
  }

  const actual = crypto
    .createHash('sha256')
    .update(token, 'utf8')
    .digest();

  const expected = Buffer.from(
    RENDER_PRICE_BRIDGE_TOKEN_HASH,
    'hex'
  );

  if (
    actual.length !== expected.length ||
    !crypto.timingSafeEqual(actual, expected)
  ) {
    return res.status(401).json({
      error: 'unauthorized',
      etsy_modified: false
    });
  }

  next();
}

app.get('/health', async (_req, res) => {
  let etsyConnected = false;
  let etsyRefreshReady = false;

  try {
    const status = await getTokenStatus();
    etsyConnected = Boolean(status?.connected);
    etsyRefreshReady = Boolean(status?.has_refresh_token);
  } catch {}

  res.json({
    ok: true,
    service: 'vaelons-seo-manager',
    version: '4.0.0',
    mode: 'seo_only',
    thumbnail_worker: false,
    backend_openai_required_for_seo: false,
    approval_required: 'ONAYLIYORUM',
    rollback_approval_required: 'GERI_AL ONAYLIYORUM',
    etsy_connected: etsyConnected,
    etsy_refresh_ready: etsyRefreshReady,
    etsy_modified: false
  });
});

app.get('/oauth/etsy/meta', (_req, res) => {
  try {
    res.json({
      ok: true,
      client_id: etsyApiKeyForOAuth(),
      redirect_uri: `${publicBase()}/oauth/etsy/callback`,
      etsy_modified: false
    });
  } catch (error) {
    res.status(error.status || 500).json({
      error: error.message,
      etsy_modified: false
    });
  }
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

app.get(
  '/ops/render-price-manager/status',
  renderPriceBridgeAuth,
  async (_req, res, next) => {
    try {
      res.json({
        ok: true,
        bridge: 'render-price-manager',
        etsy: await getTokenStatus(),
        approval_required: 'ONAYLIYORUM',
        etsy_modified: false
      });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  '/ops/render-price-manager/variations',
  renderPriceBridgeAuth,
  async (_req, res, next) => {
    try {
      res.json({
        ok: true,
        ...(await bridgeVariationTemplates()),
        etsy_modified: false
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/ops/render-price-manager/preview',
  renderPriceBridgeAuth,
  async (req, res, next) => {
    try {
      const variationKey =
        String(req.body?.variationKey || '').trim();

      res.json({
        ok: true,
        preview: true,
        variationKey,
        ...(await bridgePreviewVariation(variationKey)),
        etsy_modified: false
      });
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/ops/render-price-manager/apply',
  renderPriceBridgeAuth,
  async (req, res, next) => {
    try {
      if (
        String(req.body?.approval || '') !==
        'ONAYLIYORUM'
      ) {
        return res.status(400).json({
          error: 'approval_required',
          required: 'ONAYLIYORUM',
          etsy_modified: false
        });
      }

      const result = await bridgeApplyVariation({
        targetKey:
          String(req.body?.variationKey || '').trim(),
        targetPrice:
          Number(req.body?.price),
        listingIds:
          req.body?.listingIds
      });

      res.json({
        ok: true,
        etsy_modified:
          result.changedCount > 0,
        ...result
      });
    } catch (error) {
      next(error);
    }
  }
);

app.use('/api', bridgeAuth);

app.get('/api/price-manager/scan', async (_req, res, next) => {
  try {
    const scan = await scanRolledCanvas13x18();
    res.json({
      ok: true,
      targetVariation: TARGET_VARIATION,
      targetPrice: TARGET_PRICE,
      etsy_modified: false,
      ...scan
    });
  } catch (error) {
    next(error);
  }
});

app.post('/api/price-manager/update', async (req, res, next) => {
  try {
    if (String(req.body?.approval || '') !== 'ONAYLIYORUM') {
      return res.status(400).json({
        error: 'approval_required',
        required: 'ONAYLIYORUM',
        etsy_modified: false
      });
    }

    const offset = Math.max(0, Number(req.body?.offset || 0) || 0);
    const limit = clampInt(req.body?.limit || 12, 1, 20);

    const result = await updateRolledCanvas13x18({
      offset,
      limit,
      targetPrice: TARGET_PRICE
    });

    res.json({
      ok: true,
      targetVariation: TARGET_VARIATION,
      targetPrice: TARGET_PRICE,
      etsy_modified: result.results.some((row) => row.status === 'UPDATED'),
      ...result
    });
  } catch (error) {
    next(error);
  }
});

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


app.get('/api/variation-intelligence/status', async (_req, res, next) => {
  try {
    res.json(await getVariationIntelligenceStatus());
  } catch (error) {
    next(error);
  }
});

app.get('/api/variation-intelligence/scan', async (req, res, next) => {
  try {
    const includeRows = ['1', 'true', 'yes'].includes(
      String(req.query.include_rows || '').toLowerCase()
    );
    const useCache = !['0', 'false', 'no'].includes(
      String(req.query.use_cache ?? 'true').toLowerCase()
    );

    res.json(
      await scanVariationIntelligence({
        state: String(req.query.state || 'active'),
        listingLimit: clampInt(req.query.listing_limit || 300, 1, 500),
        includeRows,
        sampleRowsPerListing: clampInt(req.query.sample_rows || 3, 0, 20),
        useCache
      })
    );
  } catch (error) {
    next(error);
  }
});

app.get(
  '/api/variation-intelligence/listings/:listingId',
  async (req, res, next) => {
    try {
      res.json(
        await getListingVariationIntelligence(
          asListingId(req.params.listingId)
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

app.post(
  '/api/variation-intelligence/evaluate/:listingId',
  async (req, res, next) => {
    try {
      res.json(
        await evaluateListingProfit(
          asListingId(req.params.listingId),
          req.body || {}
        )
      );
    } catch (error) {
      next(error);
    }
  }
);

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
