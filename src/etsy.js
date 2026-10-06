import { openJson } from './crypto.js';

const API = 'https://api.etsy.com/v3/application';

/* =========================================================
   BASIC
========================================================= */

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

function asPositiveId(value, name = 'id') {
  const id = String(value ?? '').trim();

  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    throw new Error(`${name} must be a positive numeric ID`);
  }

  return id;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* =========================================================
   API SAFETY — GLOBAL THROTTLE / CACHE / 429 BACKOFF
========================================================= */

const ETSY_MIN_REQUEST_GAP_MS = Math.max(
  250,
  Number(process.env.ETSY_MIN_REQUEST_GAP_MS || 400)
);

const ETSY_READ_CACHE_TTL_MS = Math.max(
  10_000,
  Number(process.env.ETSY_READ_CACHE_TTL_MS || 300_000)
);

const ETSY_DAILY_RESERVE = Math.max(
  0,
  Number(process.env.ETSY_DAILY_RESERVE || 100)
);

const ETSY_MAX_RETRIES = Math.max(
  0,
  Math.min(4, Number(process.env.ETSY_MAX_RETRIES || 2))
);

let requestTail = Promise.resolve();
let nextRequestAt = 0;
let blockedUntil = 0;

const readCache = new Map();
const inFlightReads = new Map();

let rateState = {
  limitPerSecond: null,
  remainingThisSecond: null,
  limitPerDay: null,
  remainingToday: null,
  retryAfterSeconds: null,
  updatedAt: null
};

function numericHeader(res, ...names) {
  for (const name of names) {
    const raw = res.headers.get(name);
    if (raw !== null && raw !== '') {
      const value = Number(raw);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

function updateRateState(res) {
  rateState = {
    limitPerSecond: numericHeader(res, 'x-limit-per-second'),
    remainingThisSecond: numericHeader(
      res,
      'x-remaining-this-second',
      'x-remaining-this-secon'
    ),
    limitPerDay: numericHeader(res, 'x-limit-per-day'),
    remainingToday: numericHeader(res, 'x-remaining-today'),
    retryAfterSeconds: numericHeader(res, 'retry-after'),
    updatedAt: Date.now()
  };

  if (res.status === 429) {
    blockedUntil = Math.max(
      blockedUntil,
      Date.now() + retryDelayMs(res, 0)
    );
  } else if (
    rateState.remainingThisSecond !== null &&
    rateState.remainingThisSecond <= 0
  ) {
    blockedUntil = Math.max(
      blockedUntil,
      Date.now() + 1000
    );
  }
}

export function getEtsyRateLimitStatus() {
  return { ...rateState };
}

function retryDelayMs(res, attempt) {
  const raw = res.headers.get('retry-after');

  if (raw) {
    const seconds = Number(raw);

    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.max(1000, Math.ceil(seconds * 1000));
    }

    const date = Date.parse(raw);

    if (Number.isFinite(date)) {
      return Math.max(1000, date - Date.now());
    }
  }

  return Math.min(
    60_000,
    1000 * Math.pow(2, Math.max(0, attempt))
  );
}

async function scheduleEtsyRequest(fn) {
  const run = requestTail.then(async () => {
    if (
      rateState.remainingToday !== null &&
      rateState.remainingToday <= ETSY_DAILY_RESERVE
    ) {
      const err = new Error(
        'Etsy daily API safety reserve reached; requests paused.'
      );

      err.status = 429;
      err.code = 'ETSY_DAILY_RESERVE';
      err.rateLimit = { ...rateState };
      throw err;
    }

    const waitMs = Math.max(
      0,
      Math.max(
        nextRequestAt,
        blockedUntil
      ) - Date.now()
    );

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    const result = await fn();

    nextRequestAt =
      Date.now() +
      ETSY_MIN_REQUEST_GAP_MS;

    return result;
  });

  requestTail = run.catch(() => {});

  return run;
}

async function protectedFetch(url, options) {
  let attempt = 0;

  while (true) {
    const res =
      await scheduleEtsyRequest(
        () => fetch(url, options)
      );

    updateRateState(res);

    const retryable =
      res.status === 429 ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504;

    if (!retryable) {
      return res;
    }

    if (attempt >= ETSY_MAX_RETRIES) {
      return res;
    }

    const delayMs =
      res.status === 429
        ? retryDelayMs(res, attempt)
        : Math.min(15_000, 1000 * Math.pow(2, attempt));

    // Fail closed rather than retrying before a long Etsy cooldown ends.
    if (res.status === 429 && delayMs > 60_000) {
      return res;
    }

    await sleep(delayMs);
    attempt += 1;
  }
}

function cacheGet(key) {
  const hit = readCache.get(key);

  if (!hit) return null;

  if (hit.expiresAt <= Date.now()) {
    readCache.delete(key);
    return null;
  }

  return hit.data;
}

function cacheSet(key, data) {
  if (readCache.size >= 2000) {
    const oldest = readCache.keys().next().value;
    if (oldest) readCache.delete(oldest);
  }

  readCache.set(key, {
    data,
    expiresAt:
      Date.now() +
      ETSY_READ_CACHE_TTL_MS
  });
}

function clearReadCache() {
  readCache.clear();
}

/* =========================================================
   TOKEN
========================================================= */

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

  const text = await res.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!res.ok) {
    throw new Error(
      `Etsy token refresh failed (${res.status}): ${JSON.stringify(data)}`
    );
  }

  const token = {
    ...data,

    // If Etsy does not rotate the refresh token,
    // keep the currently valid one.
    refresh_token:
      data?.refresh_token ||
      refreshToken,

    obtained_at:
      Date.now()
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
  const token =
    tokenCache ||
    envTokenCapsule();

  return {
    connected:
      Boolean(
        token ||
        process.env.ETSY_REFRESH_TOKEN ||
        process.env.ETSY_TOKEN_CAPSULE
      ),

    has_cached_access_token:
      Boolean(
        tokenCache?.access_token
      ),

    has_refresh_token:
      Boolean(
        token?.refresh_token ||
        process.env.ETSY_REFRESH_TOKEN ||
        process.env.ETSY_TOKEN_CAPSULE
      ),

    scope:
      token?.scope ||
      null,

    obtained_at:
      token?.obtained_at ||
      null
  };
}

async function getAccessToken() {
  let token =
    tokenCache ||
    envTokenCapsule();

  if (token) {
    tokenCache = token;
  }

  const stillFresh =
    Boolean(
      token?.access_token &&
      token?.obtained_at &&
      Date.now() -
        Number(token.obtained_at) <
        50 * 60 * 1000
    );

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

  token =
    await refreshAccessToken(
      refreshToken
    );

  return token.access_token;
}

/* =========================================================
   GENERIC ETSY REQUEST
========================================================= */

export async function etsyRequest(
  path,
  {
    method = 'GET',
    params,
    body,
    json,
    multipart
  } = {}
) {
  const token =
    await getAccessToken();

  const normalizedPath =
    String(path || '').startsWith('/')
      ? String(path)
      : `/${String(path || '')}`;

  const url =
    new URL(
      `${API}${normalizedPath}`
    );

  if (params) {
    for (
      const [key, value]
      of Object.entries(params)
    ) {
      if (
        value === undefined ||
        value === null ||
        value === ''
      ) {
        continue;
      }

      if (Array.isArray(value)) {
        url.searchParams.set(
          key,
          value.join(',')
        );
      } else {
        url.searchParams.set(
          key,
          String(value)
        );
      }
    }
  }

  const headers = {
    'x-api-key':
      apiKeyHeader(),

    authorization:
      `Bearer ${token}`
  };

  let payload;

  if (multipart) {
    payload = multipart;

  } else if (json !== undefined) {
    headers['content-type'] =
      'application/json; charset=utf-8';

    payload = JSON.stringify(json);

  } else if (body) {
    const form =
      new URLSearchParams();

    for (
      const [key, value]
      of Object.entries(body)
    ) {
      if (
        value === undefined ||
        value === null
      ) {
        continue;
      }

      if (Array.isArray(value)) {
        form.set(
          key,
          value.join(',')
        );

      } else if (
        typeof value === 'boolean'
      ) {
        form.set(
          key,
          value
            ? 'true'
            : 'false'
        );

      } else {
        form.set(
          key,
          String(value)
        );
      }
    }

    headers['content-type'] =
      'application/x-www-form-urlencoded; charset=utf-8';

    payload = form;
  }

  const upperMethod =
    String(method || 'GET')
      .toUpperCase();

  const cacheKey =
    `private:${upperMethod}:${url.toString()}`;

  if (upperMethod === 'GET') {
    const cached =
      cacheGet(cacheKey);

    if (cached !== null) {
      return cached;
    }

    const existing =
      inFlightReads.get(cacheKey);

    if (existing) {
      return existing;
    }
  }

  const execute =
    async () => {
      const res =
        await protectedFetch(
          url,
          {
            method: upperMethod,
            headers,
            body: payload
          }
        );

      const text =
        await res.text();

      let data = null;

      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }

      if (!res.ok) {
        const err =
          new Error(
            `Etsy API ${upperMethod} ${normalizedPath} failed (${res.status})`
          );

        err.status = res.status;
        err.details = data;
        err.rateLimit = { ...rateState };
        err.retryAfterMs =
          res.status === 429
            ? retryDelayMs(res, ETSY_MAX_RETRIES)
            : null;

        throw err;
      }

      if (upperMethod === 'GET') {
        cacheSet(cacheKey, data);
      } else {
        clearReadCache();
      }

      return data;
    };

  if (upperMethod !== 'GET') {
    return execute();
  }

  const pending =
    execute()
      .finally(
        () => inFlightReads.delete(cacheKey)
      );

  inFlightReads.set(
    cacheKey,
    pending
  );

  return pending;
}


export async function etsyPublicRequest(
  path,
  {
    params
  } = {}
) {
  const normalizedPath =
    String(path || '').startsWith('/')
      ? String(path)
      : `/${String(path || '')}`;

  const url =
    new URL(
      `${API}${normalizedPath}`
    );

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (
        value === undefined ||
        value === null ||
        value === ''
      ) {
        continue;
      }

      if (Array.isArray(value)) {
        url.searchParams.set(key, value.join(','));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const cacheKey =
    `public:GET:${url.toString()}`;

  const cached =
    cacheGet(cacheKey);

  if (cached !== null) {
    return cached;
  }

  const existing =
    inFlightReads.get(cacheKey);

  if (existing) {
    return existing;
  }

  const pending =
    (async () => {
      const res =
        await protectedFetch(
          url,
          {
            method: 'GET',
            headers: {
              'x-api-key': apiKeyHeader()
            }
          }
        );

      const text = await res.text();
      let data = null;

      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = { raw: text };
        }
      }

      if (!res.ok) {
        const err =
          new Error(
            `Etsy API GET ${normalizedPath} failed (${res.status})`
          );

        err.status = res.status;
        err.details = data;
        err.rateLimit = { ...rateState };
        err.retryAfterMs =
          res.status === 429
            ? retryDelayMs(res, ETSY_MAX_RETRIES)
            : null;

        throw err;
      }

      cacheSet(cacheKey, data);

      return data;
    })()
      .finally(
        () => inFlightReads.delete(cacheKey)
      );

  inFlightReads.set(
    cacheKey,
    pending
  );

  return pending;
}


/* =========================================================
   SHOP
========================================================= */

export async function getShopId() {
  if (process.env.ETSY_SHOP_ID) {
    return String(
      process.env.ETSY_SHOP_ID
    );
  }

  let token =
    tokenCache ||
    envTokenCapsule();

  if (token?.shop_id) {
    return String(
      token.shop_id
    );
  }

  const sourceToken =
    token?.access_token ||
    token?.refresh_token ||
    process.env.ETSY_REFRESH_TOKEN;

  const userId =
    sourceToken
      ?.split('.')
      ?.[0];

  if (
    !userId ||
    !/^\d+$/.test(userId)
  ) {
    throw new Error(
      'Unable to infer Etsy user/shop ID. Set ETSY_SHOP_ID or complete OAuth.'
    );
  }

  const accessToken =
    await getAccessToken();

  const res =
    await fetch(
      `${API}/users/${userId}/shops`,
      {
        headers: {
          'x-api-key':
            apiKeyHeader(),

          authorization:
            `Bearer ${accessToken}`
        }
      }
    );

  const text =
    await res.text();

  let data;

  try {
    data =
      text
        ? JSON.parse(text)
        : {};

  } catch {
    data = {
      raw:
        text
    };
  }

  if (!res.ok) {
    throw new Error(
      `Unable to resolve Etsy shop (${res.status}): ${JSON.stringify(data)}`
    );
  }

  const expectedShopName =
    String(
      process.env
        .ETSY_EXPECTED_SHOP_NAME ||
      'VAELONS'
    )
      .trim()
      .toLowerCase();

  const actualShopName =
    String(
      data?.shop_name ||
      ''
    )
      .trim()
      .toLowerCase();

  if (
    actualShopName !==
    expectedShopName
  ) {
    throw new Error(
      `Authorized Etsy account owns shop '${data?.shop_name}', expected '${process.env.ETSY_EXPECTED_SHOP_NAME || 'VAELONS'}'.`
    );
  }

  if (token) {
    token.shop_id =
      data.shop_id;

    tokenCache =
      token;
  }

  return String(
    data.shop_id
  );
}

export function etsyApiKeyForOAuth() {
  return required(
    'ETSY_KEYSTRING'
  );
}

export function etsySharedSecret() {
  return required(
    'ETSY_SHARED_SECRET'
  );
}

/* =========================================================
   LISTING IMAGE READ
========================================================= */

export async function getListingImages(
  listingId
) {
  const id =
    asPositiveId(
      listingId,
      'listingId'
    );

  const data =
    await etsyRequest(
      `/listings/${encodeURIComponent(id)}/images`
    );

  return {
    count:
      Number(
        data?.count ??
        data?.results?.length ??
        0
      ),

    results:
      Array.isArray(
        data?.results
      )
        ? data.results
        : []
  };
}

export async function getListingImage(
  listingId,
  listingImageId
) {
  const id =
    asPositiveId(
      listingId,
      'listingId'
    );

  const imageId =
    asPositiveId(
      listingImageId,
      'listingImageId'
    );

  return etsyRequest(
    `/listings/${encodeURIComponent(id)}/images/${encodeURIComponent(imageId)}`
  );
}

/* =========================================================
   LISTING IMAGE UPLOAD / RE-ASSIGN / RANK
========================================================= */

export async function uploadListingImage({
  shopId,
  listingId,

  imageBuffer = null,
  listingImageId = null,

  filename = 'image.jpg',
  contentType = 'image/jpeg',

  rank = 1,
  overwrite = false,
  isWatermarked = false,
  altText = ''
}) {
  const sid =
    asPositiveId(
      shopId,
      'shopId'
    );

  const lid =
    asPositiveId(
      listingId,
      'listingId'
    );

  const hasBuffer =
    Boolean(
      imageBuffer
    );

  const hasExistingImage =
    listingImageId !==
      undefined &&
    listingImageId !==
      null &&
    String(
      listingImageId
    ).trim() !== '';

  if (
    hasBuffer &&
    hasExistingImage
  ) {
    throw new Error(
      'Provide imageBuffer or listingImageId, not both'
    );
  }

  if (
    !hasBuffer &&
    !hasExistingImage
  ) {
    throw new Error(
      'imageBuffer or listingImageId is required'
    );
  }

  const safeRank =
    Math.max(
      0,
      Math.round(
        Number(
          rank ?? 1
        )
      )
    );

  const form =
    new FormData();

  if (hasBuffer) {
    const bytes =
      imageBuffer
        instanceof Uint8Array
        ? imageBuffer
        : new Uint8Array(
            imageBuffer
          );

    const blob =
      new Blob(
        [bytes],
        {
          type:
            contentType ||
            'image/jpeg'
        }
      );

    form.append(
      'image',
      blob,
      filename ||
        'image.jpg'
    );

  } else {
    form.append(
      'listing_image_id',
      asPositiveId(
        listingImageId,
        'listingImageId'
      )
    );
  }

  form.append(
    'rank',
    String(
      safeRank
    )
  );

  form.append(
    'overwrite',
    overwrite
      ? 'true'
      : 'false'
  );

  form.append(
    'is_watermarked',
    isWatermarked
      ? 'true'
      : 'false'
  );

  if (
    altText !==
      undefined &&
    altText !==
      null
  ) {
    const safeAltText =
      String(
        altText
      ).slice(
        0,
        500
      );

    form.append(
      'alt_text',
      safeAltText
    );
  }

  return etsyRequest(
    `/shops/${encodeURIComponent(sid)}/listings/${encodeURIComponent(lid)}/images`,
    {
      method:
        'POST',

      multipart:
        form
    }
  );
}

/* =========================================================
   IMAGE RANK
========================================================= */

export async function setListingImageRank({
  shopId,
  listingId,
  listingImageId,
  rank
}) {
  const sid =
    asPositiveId(
      shopId,
      'shopId'
    );

  const lid =
    asPositiveId(
      listingId,
      'listingId'
    );

  const iid =
    asPositiveId(
      listingImageId,
      'listingImageId'
    );

  const targetRank =
    Math.max(
      1,
      Math.round(
        Number(
          rank
        )
      )
    );

  const before =
    await getListingImages(
      lid
    );

  const exists =
    before.results.some(
      (image) =>
        String(
          image
            ?.listing_image_id ??
          image
            ?.image_id ??
          ''
        ) ===
        iid
    );

  if (!exists) {
    const err =
      new Error(
        'Listing image does not belong to this listing'
      );

    err.status =
      404;

    throw err;
  }

  await uploadListingImage({
    shopId:
      sid,

    listingId:
      lid,

    listingImageId:
      iid,

    rank:
      targetRank,

    overwrite:
      false
  });

  let verifiedImages =
    null;

  for (
    let attempt = 0;
    attempt < 5;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(
        800
      );
    }

    verifiedImages =
      await getListingImages(
        lid
      );

    const moved =
      verifiedImages
        .results
        .find(
          (image) =>
            String(
              image
                ?.listing_image_id ??
              image
                ?.image_id ??
              ''
            ) ===
            iid
        );

    if (
      moved &&
      Number(
        moved.rank
      ) ===
      targetRank
    ) {
      return {
        success:
          true,

        listing_id:
          Number(
            lid
          ),

        image_id:
          Number(
            iid
          ),

        rank:
          targetRank,

        verified:
          true,

        images:
          verifiedImages.results
      };
    }
  }

  const err =
    new Error(
      'Image rank change could not be verified'
    );

  err.status =
    409;

  err.details = {
    listing_id:
      Number(
        lid
      ),

    image_id:
      Number(
        iid
      ),

    requested_rank:
      targetRank,

    images:
      verifiedImages
        ?.results ||
      []
  };

  throw err;
}

/* =========================================================
   VARIATION IMAGE SAFETY
========================================================= */

export async function getListingVariationImages({
  shopId,
  listingId
}) {
  const sid =
    asPositiveId(
      shopId,
      'shopId'
    );

  const lid =
    asPositiveId(
      listingId,
      'listingId'
    );

  const data =
    await etsyRequest(
      `/shops/${encodeURIComponent(sid)}/listings/${encodeURIComponent(lid)}/variation-images`
    );

  return {
    count:
      Number(
        data?.count ??
        data?.results?.length ??
        0
      ),

    results:
      Array.isArray(
        data?.results
      )
        ? data.results
        : []
  };
}

export async function isListingImageUsedByVariation({
  shopId,
  listingId,
  listingImageId
}) {
  const imageId =
    asPositiveId(
      listingImageId,
      'listingImageId'
    );

  const data =
    await getListingVariationImages({
      shopId,
      listingId
    });

  return data.results.some(
    (item) =>
      String(
        item?.image_id ??
        ''
      ) ===
      imageId
  );
}

/* =========================================================
   IMAGE DELETE
========================================================= */

export async function deleteListingImage({
  shopId,
  listingId,
  listingImageId,
  verify = true
}) {
  const sid =
    asPositiveId(
      shopId,
      'shopId'
    );

  const lid =
    asPositiveId(
      listingId,
      'listingId'
    );

  const iid =
    asPositiveId(
      listingImageId,
      'listingImageId'
    );

  const before =
    await getListingImages(
      lid
    );

  if (
    before.results.length <=
    1
  ) {
    const err =
      new Error(
        'Refusing to delete the last listing image'
      );

    err.status =
      409;

    throw err;
  }

  const target =
    before.results.find(
      (image) =>
        String(
          image
            ?.listing_image_id ??
          image
            ?.image_id ??
          ''
        ) ===
        iid
    );

  if (!target) {
    return {
      success:
        true,

      deleted:
        false,

      reason:
        'image_already_absent',

      listing_id:
        Number(
          lid
        ),

      image_id:
        Number(
          iid
        ),

      verified:
        true
    };
  }

  const usedByVariation =
    await isListingImageUsedByVariation({
      shopId:
        sid,

      listingId:
        lid,

      listingImageId:
        iid
    });

  if (usedByVariation) {
    const err =
      new Error(
        'Refusing to delete an image used by a listing variation'
      );

    err.status =
      409;

    throw err;
  }

  await etsyRequest(
    `/shops/${encodeURIComponent(sid)}/listings/${encodeURIComponent(lid)}/images/${encodeURIComponent(iid)}`,
    {
      method:
        'DELETE'
    }
  );

  if (!verify) {
    return {
      success:
        true,

      deleted:
        true,

      listing_id:
        Number(
          lid
        ),

      image_id:
        Number(
          iid
        ),

      verified:
        false
    };
  }

  let after =
    null;

  for (
    let attempt = 0;
    attempt < 5;
    attempt += 1
  ) {
    if (attempt > 0) {
      await sleep(
        700
      );
    }

    after =
      await getListingImages(
        lid
      );

    const stillExists =
      after.results.some(
        (image) =>
          String(
            image
              ?.listing_image_id ??
            image
              ?.image_id ??
            ''
          ) ===
          iid
      );

    if (!stillExists) {
      return {
        success:
          true,

        deleted:
          true,

        listing_id:
          Number(
            lid
          ),

        image_id:
          Number(
            iid
          ),

        verified:
          true,

        remaining_images:
          after.results
      };
    }
  }

  const err =
    new Error(
      'Image deletion could not be verified'
    );

  err.status =
    409;

  err.details = {
    listing_id:
      Number(
        lid
      ),

    image_id:
      Number(
        iid
      ),

    current_images:
      after
        ?.results ||
      []
  };

  throw err;
}
