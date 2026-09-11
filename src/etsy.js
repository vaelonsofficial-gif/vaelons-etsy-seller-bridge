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
    payload =
      multipart;

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

    payload =
      form;
  }

  const res =
    await fetch(
      url,
      {
        method,
        headers,
        body: payload
      }
    );

  const text =
    await res.text();

  let data = null;

  if (text) {
    try {
      data =
        JSON.parse(text);

    } catch {
      data = {
        raw:
          text
      };
    }
  }

  if (!res.ok) {
    const err =
      new Error(
        `Etsy API ${method} ${normalizedPath} failed (${res.status})`
      );

    err.status =
      res.status;

    err.details =
      data;

    throw err;
  }

  return data;
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

export async function getVerifiedShopIdentity() {
  const shopId = await getShopId();
  const shop = await etsyRequest(`/shops/${encodeURIComponent(shopId)}`);
  const expectedName = String(
    process.env.ETSY_EXPECTED_SHOP_NAME || 'VAELONS'
  ).trim().toLocaleLowerCase('en-US');
  const actualName = String(shop?.shop_name || '')
    .trim()
    .toLocaleLowerCase('en-US');

  if (!actualName || actualName !== expectedName) {
    const error = new Error(
      `Authorized Etsy shop '${shop?.shop_name || 'unknown'}', expected '${process.env.ETSY_EXPECTED_SHOP_NAME || 'VAELONS'}'.`
    );
    error.status = 409;
    error.code = 'SHOP_IDENTITY_MISMATCH';
    throw error;
  }

  if (String(shop?.shop_id || '') !== String(shopId)) {
    const error = new Error('Resolved Etsy shop ID does not match verified shop identity');
    error.status = 409;
    error.code = 'SHOP_ID_MISMATCH';
    throw error;
  }

  return {
    shop_id: Number(shopId),
    shop_name: String(shop.shop_name),
    verified: true
  };
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
