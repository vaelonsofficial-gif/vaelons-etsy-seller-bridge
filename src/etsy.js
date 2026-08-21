import { openJson } from './crypto.js';

const API = 'https://api.etsy.com/v3/application';

function required(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

function apiKeyHeader() {
  return `${required('ETSY_KEYSTRING')}:${required('ETSY_SHARED_SECRET')}`;
}

let tokenCache = null;

function envTokenCapsule() {
  const blob = process.env.ETSY_TOKEN_CAPSULE;

  if (!blob) {
    return null;
  }

  return openJson(blob);
}

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: required('ETSY_KEYSTRING'),
    refresh_token: refreshToken
  });

  const res = await fetch(
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

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Etsy token refresh failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  const token = {
    ...data,
    obtained_at: Date.now()
  };

  tokenCache = token;

  return token;
}

export async function setInitialToken(token) {
  tokenCache = {
    ...token,
    obtained_at: Date.now()
  };

  return tokenCache;
}

export async function getTokenStatus() {
  const token = tokenCache || envTokenCapsule();

  return {
    connected: Boolean(
      token ||
      process.env.ETSY_REFRESH_TOKEN ||
      process.env.ETSY_TOKEN_CAPSULE
    ),
    has_cached_access_token: Boolean(token?.access_token),
    has_refresh_token: Boolean(
      token?.refresh_token ||
      process.env.ETSY_REFRESH_TOKEN ||
      process.env.ETSY_TOKEN_CAPSULE
    ),
    scope: token?.scope || null,
    obtained_at: token?.obtained_at || null
  };
}

async function getAccessToken() {
  let token = tokenCache || envTokenCapsule();

  if (token) {
    tokenCache = token;
  }

  const stillFresh =
    token?.access_token &&
    token?.obtained_at &&
    Date.now() - token.obtained_at < 50 * 60 * 1000;

  if (stillFresh) {
    return token.access_token;
  }

  const refreshToken =
    token?.refresh_token ||
    process.env.ETSY_REFRESH_TOKEN;

  if (!refreshToken) {
    throw new Error(
      'Etsy is not connected yet. Complete /oauth/etsy/start first.'
    );
  }

  token = await refreshAccessToken(refreshToken);

  return token.access_token;
}

export async function etsyRequest(
  path,
  {
    method = 'GET',
    params,
    body,
    multipart
  } = {}
) {
  const token = await getAccessToken();

  const url = new URL(`${API}${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (
        value !== undefined &&
        value !== null &&
        value !== ''
      ) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers = {
    'x-api-key': apiKeyHeader(),
    authorization: `Bearer ${token}`
  };

  let payload;

  if (multipart) {
    payload = multipart;
  } else if (body) {
    const form = new URLSearchParams();

    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) {
        continue;
      }

      if (Array.isArray(value)) {
        form.set(key, value.join(','));
      } else {
        form.set(key, String(value));
      }
    }

    headers['content-type'] =
      'application/x-www-form-urlencoded; charset=utf-8';

    payload = form;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: payload
  });

  const text = await res.text();

  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = {
      raw: text
    };
  }

  if (!res.ok) {
    const err = new Error(
      `Etsy API ${method} ${path} failed (${res.status})`
    );

    err.status = res.status;
    err.details = data;

    throw err;
  }

  return data;
}

export async function getShopId() {
  if (process.env.ETSY_SHOP_ID) {
    return String(process.env.ETSY_SHOP_ID);
  }

  let token = tokenCache || envTokenCapsule();

  if (token?.shop_id) {
    return String(token.shop_id);
  }

  const sourceToken =
    token?.access_token ||
    token?.refresh_token ||
    process.env.ETSY_REFRESH_TOKEN;

  const userId = sourceToken?.split('.')?.[0];

  if (!userId || !/^\d+$/.test(userId)) {
    throw new Error(
      'Unable to infer Etsy user/shop ID. Set ETSY_SHOP_ID or complete OAuth.'
    );
  }

  const accessToken = await getAccessToken();

  const res = await fetch(
    `${API}/users/${userId}/shops`,
    {
      headers: {
        'x-api-key': apiKeyHeader(),
        authorization: `Bearer ${accessToken}`
      }
    }
  );

  const data = await res.json();

  if (!res.ok) {
    throw new Error(
      `Unable to resolve Etsy shop (${res.status}): ${JSON.stringify(data)}`
    );
  }

  const expectedShopName =
    (
      process.env.ETSY_EXPECTED_SHOP_NAME ||
      'VAELONS'
    ).toLowerCase();

  if (
    (data.shop_name || '').toLowerCase() !==
    expectedShopName
  ) {
    throw new Error(
      `Authorized Etsy account owns shop '${data.shop_name}', expected '${process.env.ETSY_EXPECTED_SHOP_NAME || 'VAELONS'}'.`
    );
  }

  if (token) {
    token.shop_id = data.shop_id;
    tokenCache = token;
  }

  return String(data.shop_id);
}

export function etsyApiKeyForOAuth() {
  return required('ETSY_KEYSTRING');
}

export function etsySharedSecret() {
  return required('ETSY_SHARED_SECRET');
}

// --------------------------------------------------
// LISTING IMAGE HELPERS
// --------------------------------------------------

export async function getListingImages(listingId) {
  if (!listingId) {
    throw new Error('listingId is required');
  }

  const data = await etsyRequest(
    `/listings/${encodeURIComponent(listingId)}`,
    {
      params: {
        includes: 'Images'
      }
    }
  );

  return {
    results:
      data?.images ||
      data?.Images ||
      []
  };
}

export async function uploadListingImage({
  shopId,
  listingId,
  imageBuffer,
  filename = 'image.jpg',
  contentType = 'image/jpeg'
}) {
  if (!shopId) {
    throw new Error('shopId is required');
  }

  if (!listingId) {
    throw new Error('listingId is required');
  }

  if (!imageBuffer) {
    throw new Error('imageBuffer is required');
  }

  const form = new FormData();

  const bytes =
    imageBuffer instanceof Uint8Array
      ? imageBuffer
      : new Uint8Array(imageBuffer);

  const blob = new Blob(
    [bytes],
    {
      type: contentType
    }
  );

  form.append(
    'image',
    blob,
    filename
  );

  return etsyRequest(
    `/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}/images`,
    {
      method: 'POST',
      multipart: form
    }
  );
}
