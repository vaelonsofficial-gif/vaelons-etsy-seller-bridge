import { openJson } from './crypto.js';

const API = 'https://api.etsy.com/v3/application';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable: ${name}`);
  return v;
}

function apiKeyHeader() {
  return `${required('ETSY_KEYSTRING')}:${required('ETSY_SHARED_SECRET')}`;
}

let tokenCache = null;

function envTokenCapsule() {
  const blob = process.env.ETSY_TOKEN_CAPSULE;
  if (!blob) return null;
  return openJson(blob);
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: required('ETSY_KEYSTRING'),
    refresh_token: refreshToken
  });
  const res = await fetch(https://api.etsy.com/v3/public/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Etsy token refresh failed (${res.status}): ${JSON.stringify(data)}`);
  const token = { ...data, obtained_at: Date.now() };
  tokenCache = token;
  return token;
}

export async function setInitialToken(token) {
  tokenCache = { ...token, obtained_at: Date.now() };
  return tokenCache;
}

export async function getTokenStatus() {
  const t = tokenCache || envTokenCapsule();
  return {
    connected: Boolean(t || process.env.ETSY_REFRESH_TOKEN || process.env.ETSY_TOKEN_CAPSULE),
    has_cached_access_token: Boolean(t?.access_token),
    has_refresh_token: Boolean(t?.refresh_token || process.env.ETSY_REFRESH_TOKEN || process.env.ETSY_TOKEN_CAPSULE),
    scope: t?.scope || null,
    obtained_at: t?.obtained_at || null
  };
}

async function getAccessToken() {
  let t = tokenCache || envTokenCapsule();
  if (t) tokenCache = t;
  const stillFresh = t?.access_token && t?.obtained_at && (Date.now() - t.obtained_at < 50 * 60 * 1000);
  if (stillFresh) return t.access_token;
  const refresh = t?.refresh_token || process.env.ETSY_REFRESH_TOKEN;
  if (!refresh) throw new Error('Etsy is not connected yet. Complete /oauth/etsy/start first.');
  t = await refreshAccessToken(refresh);
  return t.access_token;
}

export async function etsyRequest(path, { method = 'GET', params, body, multipart } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API}${path}`);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  const headers = {
    'x-api-key': apiKeyHeader(),
    'authorization': `Bearer ${token}`
  };
  let payload;
  if (multipart) {
    payload = multipart;
  } else if (body) {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) form.set(k, v.join(','));
      else form.set(k, String(v));
    }
    headers['content-type'] = 'application/x-www-form-urlencoded; charset=utf-8';
    payload = form;
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Etsy API ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.details = data;
    throw err;
  }
  return data;
}

export async function getShopId() {
  if (process.env.ETSY_SHOP_ID) return process.env.ETSY_SHOP_ID;
  let t = tokenCache || envTokenCapsule();
  if (t?.shop_id) return String(t.shop_id);
  const sourceToken = t?.access_token || t?.refresh_token || process.env.ETSY_REFRESH_TOKEN;
  const userId = sourceToken?.split('.')?.[0];
  if (!userId || !/^\d+$/.test(userId)) throw new Error('Unable to infer Etsy user/shop ID. Set ETSY_SHOP_ID or complete OAuth.');
  const accessToken = await getAccessToken();
  const res = await fetch(`${API}/application/users/${userId}/shops`, {
    headers: {
      'x-api-key': apiKeyHeader(),
      'authorization': `Bearer ${accessToken}`
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Unable to resolve Etsy shop (${res.status}): ${JSON.stringify(data)}`);
  const expected = (process.env.ETSY_EXPECTED_SHOP_NAME || 'VAELONS').toLowerCase();
  if ((data.shop_name || '').toLowerCase() !== expected) throw new Error(`Authorized Etsy account owns shop '${data.shop_name}', expected '${process.env.ETSY_EXPECTED_SHOP_NAME || 'VAELONS'}'.`);
  if (t) {
    t.shop_id = data.shop_id;
    tokenCache = t;
  }
  return String(data.shop_id);
}
export function etsyApiKeyForOAuth() { return required('ETSY_KEYSTRING'); }
export function etsySharedSecret() { return required('ETSY_SHARED_SECRET'); }
// ---- Listing image helpers ----

export async function getListingImages(listingId) {
  return etsyRequest(
    `/listings/${encodeURIComponent(listingId)}/images`
  );
}

export async function uploadListingImage({
  shopId,
  listingId,
  imageBuffer,
  filename = "image.jpg",
  contentType = "image/jpeg"
}) {
  if (!shopId) throw new Error("shopId is required");
  if (!listingId) throw new Error("listingId is required");
  if (!imageBuffer) throw new Error("imageBuffer is required");

  const form = new FormData();

  const bytes =
    imageBuffer instanceof Uint8Array
      ? imageBuffer
      : new Uint8Array(imageBuffer);

  const blob = new Blob([bytes], {
    type: contentType
  });

  form.append("image", blob, filename);

  return etsyRequest(
    `/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}/images`,
    {
      method: "POST",
      multipart: form
    }
  );
}
