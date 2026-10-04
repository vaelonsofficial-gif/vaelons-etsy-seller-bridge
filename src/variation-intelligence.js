import {
  etsyRequest,
  getShopId,
  getTokenStatus
} from './etsy.js';

export const VARIATION_INTELLIGENCE_VERSION = '1.0.0';

const CACHE_TTL_MS = 60 * 1000;
const scanCache = new Map();

function clampInt(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeSize(value) {
  return normalizeText(value)
    .replace(/[×✕]/g, 'x')
    .replace(/\s+/g, '')
    .replace(/centimeters?|centimetres?|cm\b/g, 'cm');
}

function normalizeStyle(value) {
  const text = normalizeText(value);

  if (/\b(roll|rolled|roll-up|unstretched)\b/.test(text)) {
    return 'rolled_canvas';
  }

  if (/\b(framed|floating frame|floater frame|wood frame)\b/.test(text)) {
    return 'framed_canvas';
  }

  if (/\b(stretched|gallery wrap|ready to hang|ready-to-hang|panel)\b/.test(text)) {
    return 'stretched_canvas';
  }

  if (/\b(poster|paper print|fine art paper)\b/.test(text)) {
    return 'paper_print';
  }

  return text || null;
}

function canonicalPropertyName(name) {
  const text = normalizeText(name);

  if (/size|dimension|ölçü|ebat/.test(text)) {
    return 'size';
  }

  if (
    /frame/.test(text) &&
    /(color|colour|finish|tone|renk)/.test(text)
  ) {
    return 'frame_color';
  }

  if (/frame color|frame colour|çerçeve rengi/.test(text)) {
    return 'frame_color';
  }

  if (/canvas style|canvas type|product type|model|style|type|format|finish/.test(text)) {
    return 'canvas_style';
  }

  if (/primary color|secondary color|colour|color|renk/.test(text)) {
    return 'color';
  }

  return text.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'property';
}

function moneyValue(money) {
  if (!money || typeof money !== 'object') {
    return {
      amount: null,
      currency: null
    };
  }

  const divisor = Number(money.divisor || 100);
  const rawAmount = Number(money.amount);

  return {
    amount:
      Number.isFinite(rawAmount) && Number.isFinite(divisor) && divisor !== 0
        ? rawAmount / divisor
        : null,
    currency: money.currency_code || null
  };
}

function propertyEntries(product) {
  const values = Array.isArray(product?.property_values)
    ? product.property_values
    : [];

  return values.map((property) => {
    const displayValues = Array.isArray(property?.values)
      ? property.values.map((value) => String(value))
      : [];

    return {
      property_id: property?.property_id ?? null,
      property_name: property?.property_name || '',
      canonical_name: canonicalPropertyName(property?.property_name || ''),
      values: displayValues,
      value: displayValues.join(' / '),
      value_ids: Array.isArray(property?.value_ids)
        ? property.value_ids
        : []
    };
  });
}

function canonicalProperties(properties) {
  const result = {};

  for (const property of properties) {
    const key = property.canonical_name;
    const value = property.value;

    if (!key || !value) continue;

    if (result[key]) {
      result[key] = `${result[key]} / ${value}`;
    } else {
      result[key] = value;
    }
  }

  const allValues = Object.values(result).join(' ');

  if (!result.canvas_style) {
    const inferred = normalizeStyle(allValues);
    if (
      inferred &&
      ['rolled_canvas', 'framed_canvas', 'stretched_canvas', 'paper_print'].includes(inferred)
    ) {
      result.canvas_style = inferred;
    }
  } else {
    result.canvas_style_raw = result.canvas_style;
    result.canvas_style = normalizeStyle(result.canvas_style);
  }

  if (result.size) {
    result.size_normalized = normalizeSize(result.size);
  }

  return result;
}

function flattenListingInventory(listing, inventory) {
  const products = Array.isArray(inventory?.products)
    ? inventory.products
    : [];

  const rows = [];

  for (const product of products) {
    const properties = propertyEntries(product);
    const canonical = canonicalProperties(properties);
    const offerings = Array.isArray(product?.offerings)
      ? product.offerings
      : [];

    for (const offering of offerings.length ? offerings : [null]) {
      const price = moneyValue(offering?.price);

      rows.push({
        listing_id: Number(listing?.listing_id || inventory?.listing?.listing_id || 0) || null,
        title: listing?.title || '',
        state: listing?.state || null,
        url: listing?.url || null,
        product_id: product?.product_id ?? null,
        sku: product?.sku || '',
        offering_id: offering?.offering_id ?? null,
        enabled: offering ? offering?.is_enabled !== false : null,
        quantity:
          offering && Number.isFinite(Number(offering?.quantity))
            ? Number(offering.quantity)
            : null,
        readiness_state_id: offering?.readiness_state_id ?? null,
        price: price.amount,
        currency: price.currency,
        properties,
        canonical
      });
    }
  }

  return rows;
}

function summarizeListing(listing, inventory, sampleRowsPerListing = 3) {
  const rows = flattenListingInventory(listing, inventory);
  const enabledRows = rows.filter((row) => row.enabled !== false);
  const activeRows = enabledRows.length ? enabledRows : rows;

  const propertyNames = new Set();
  let maxVariationDepth = 0;
  let hasFramedVariant = false;
  let hasRolledVariant = false;
  let hasStretchedVariant = false;

  for (const row of rows) {
    maxVariationDepth = Math.max(maxVariationDepth, row.properties.length);
    for (const property of row.properties) {
      if (property.property_name) propertyNames.add(property.property_name);
    }

    if (row.canonical?.canvas_style === 'framed_canvas') hasFramedVariant = true;
    if (row.canonical?.canvas_style === 'rolled_canvas') hasRolledVariant = true;
    if (row.canonical?.canvas_style === 'stretched_canvas') hasStretchedVariant = true;
  }

  const numericPrices = activeRows
    .map((row) => Number(row.price))
    .filter(Number.isFinite);

  const currencies = [
    ...new Set(activeRows.map((row) => row.currency).filter(Boolean))
  ];

  const canonicalNames = new Set();
  for (const row of rows) {
    for (const key of Object.keys(row.canonical || {})) {
      if (!key.endsWith('_raw') && !key.endsWith('_normalized')) {
        canonicalNames.add(key);
      }
    }
  }

  const recommendations = [];

  if (!inventory) recommendations.push('NO_INVENTORY');
  if (!canonicalNames.has('size')) recommendations.push('SIZE_VARIATION_NOT_DETECTED');
  if (!canonicalNames.has('canvas_style')) recommendations.push('CANVAS_STYLE_VARIATION_NOT_DETECTED');
  if (hasFramedVariant && !canonicalNames.has('frame_color')) {
    recommendations.push('FRAME_COLOR_NOT_EXPOSED');
  }
  if (maxVariationDepth < 3 && hasFramedVariant) {
    recommendations.push('THIRD_VARIATION_OPPORTUNITY');
  }

  if ([...propertyNames].some((name) => normalizeText(name) === 'model')) {
    recommendations.push('RENAME_MODEL_TO_CANVAS_STYLE');
  }

  return {
    listing_id: Number(listing?.listing_id || inventory?.listing?.listing_id || 0) || null,
    title: listing?.title || '',
    state: listing?.state || null,
    url: listing?.url || null,
    variation_depth: maxVariationDepth,
    property_names: [...propertyNames],
    canonical_properties: [...canonicalNames],
    product_count: Array.isArray(inventory?.products) ? inventory.products.length : 0,
    offering_count: rows.length,
    enabled_offering_count: enabledRows.length,
    currency: currencies.length === 1 ? currencies[0] : currencies,
    min_price: numericPrices.length ? Math.min(...numericPrices) : null,
    max_price: numericPrices.length ? Math.max(...numericPrices) : null,
    has_framed_variant: hasFramedVariant,
    has_rolled_variant: hasRolledVariant,
    has_stretched_variant: hasStretchedVariant,
    has_third_variation: maxVariationDepth >= 3,
    recommendations,
    sample_rows: rows.slice(0, sampleRowsPerListing)
  };
}

function chunk(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

function inventoryMapFromBatch(batchResponse) {
  const map = new Map();
  const results = Array.isArray(batchResponse?.results)
    ? batchResponse.results
    : [];

  for (const item of results) {
    const listingId = Number(item?.listing_id || item?.inventory?.listing?.listing_id || 0);
    if (!listingId) continue;
    map.set(listingId, item?.inventory ?? item);
  }

  return map;
}

async function fetchListingPage({ shopId, state, limit, offset }) {
  return etsyRequest(`/shops/${shopId}/listings`, {
    params: {
      state,
      limit,
      offset
    }
  });
}

async function fetchListings({ state, listingLimit }) {
  const shopId = await getShopId();
  const listings = [];
  let offset = 0;
  const pageSize = Math.min(100, listingLimit);
  let totalCount = null;

  while (listings.length < listingLimit) {
    const page = await fetchListingPage({
      shopId,
      state,
      limit: Math.min(pageSize, listingLimit - listings.length),
      offset
    });

    const rows = Array.isArray(page?.results) ? page.results : [];
    totalCount = Number(page?.count ?? totalCount ?? rows.length);
    listings.push(...rows);

    if (!rows.length || rows.length < pageSize || listings.length >= totalCount) {
      break;
    }

    offset += rows.length;
  }

  return {
    shopId,
    totalCount: Number.isFinite(totalCount) ? totalCount : listings.length,
    listings: listings.slice(0, listingLimit)
  };
}

async function fetchBatchInventories(listingIds) {
  const inventories = new Map();

  for (const ids of chunk(listingIds, 100)) {
    const batch = await etsyRequest('/listings/batch/inventory', {
      params: {
        listing_ids: ids
      }
    });

    const batchMap = inventoryMapFromBatch(batch);
    for (const [listingId, inventory] of batchMap.entries()) {
      inventories.set(listingId, inventory);
    }
  }

  return inventories;
}

export async function getVariationIntelligenceStatus() {
  return {
    ok: true,
    version: VARIATION_INTELLIGENCE_VERSION,
    mode: 'read_only',
    batch_size: 100,
    max_variations_supported: 3,
    etsy: await getTokenStatus(),
    etsy_modified: false
  };
}

export async function scanVariationIntelligence({
  state = 'active',
  listingLimit = 300,
  includeRows = false,
  sampleRowsPerListing = 3,
  useCache = true
} = {}) {
  const safeLimit = clampInt(listingLimit, 1, 500, 300);
  const safeSamples = clampInt(sampleRowsPerListing, 0, 20, 3);
  const normalizedState = String(state || 'active');
  const cacheKey = `${normalizedState}:${safeLimit}:${includeRows ? 1 : 0}:${safeSamples}`;
  const cached = scanCache.get(cacheKey);

  if (useCache && cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return {
      ...cached.value,
      cache: 'HIT'
    };
  }

  const startedAt = Date.now();
  const { shopId, totalCount, listings } = await fetchListings({
    state: normalizedState,
    listingLimit: safeLimit
  });

  const listingIds = listings
    .map((listing) => Number(listing?.listing_id))
    .filter((id) => Number.isFinite(id) && id > 0);

  const inventories = await fetchBatchInventories(listingIds);
  const summaries = [];
  const allRows = [];

  for (const listing of listings) {
    const listingId = Number(listing?.listing_id);
    const inventory = inventories.get(listingId) || null;
    const summary = summarizeListing(listing, inventory, safeSamples);
    summaries.push(summary);

    if (includeRows) {
      allRows.push(...flattenListingInventory(listing, inventory));
    }
  }

  const recommendationCounts = {};
  let threeVariationListings = 0;
  let framedWithoutFrameColor = 0;
  let listingsWithInventory = 0;
  let totalOfferings = 0;

  for (const summary of summaries) {
    if (summary.product_count > 0) listingsWithInventory += 1;
    if (summary.has_third_variation) threeVariationListings += 1;
    if (
      summary.has_framed_variant &&
      !summary.canonical_properties.includes('frame_color')
    ) {
      framedWithoutFrameColor += 1;
    }
    totalOfferings += summary.offering_count;

    for (const code of summary.recommendations) {
      recommendationCounts[code] = (recommendationCounts[code] || 0) + 1;
    }
  }

  const value = {
    ok: true,
    version: VARIATION_INTELLIGENCE_VERSION,
    mode: 'read_only',
    shop_id: shopId,
    state: normalizedState,
    total_listing_count: totalCount,
    scanned_listing_count: summaries.length,
    listings_with_inventory: listingsWithInventory,
    three_variation_listings: threeVariationListings,
    framed_without_frame_color: framedWithoutFrameColor,
    total_offerings: totalOfferings,
    recommendation_counts: recommendationCounts,
    duration_ms: Date.now() - startedAt,
    listings: summaries,
    ...(includeRows ? { rows: allRows } : {}),
    etsy_modified: false
  };

  scanCache.set(cacheKey, {
    createdAt: Date.now(),
    value
  });

  return {
    ...value,
    cache: 'MISS'
  };
}

export async function getListingVariationIntelligence(listingId) {
  const id = String(listingId ?? '').trim();
  if (!/^\d+$/.test(id) || Number(id) <= 0) {
    const error = new Error('Invalid listingId');
    error.status = 400;
    throw error;
  }

  const [listing, inventory] = await Promise.all([
    etsyRequest(`/listings/${id}`),
    etsyRequest(`/listings/${id}/inventory`)
  ]);

  return {
    ok: true,
    version: VARIATION_INTELLIGENCE_VERSION,
    mode: 'read_only',
    listing: summarizeListing(listing, inventory, 10),
    rows: flattenListingInventory(listing, inventory),
    etsy_modified: false
  };
}

function findCostRule(costRules, row) {
  const style = normalizeStyle(row?.canonical?.canvas_style || '');
  const size = normalizeSize(row?.canonical?.size || '');
  const frameColor = normalizeText(row?.canonical?.frame_color || '');

  return (Array.isArray(costRules) ? costRules : []).find((rule) => {
    const ruleStyle = normalizeStyle(rule?.canvas_style || rule?.style || '');
    const ruleSize = normalizeSize(rule?.size || '');
    const ruleFrameColor = normalizeText(rule?.frame_color || '');

    if (ruleStyle && ruleStyle !== style) return false;
    if (ruleSize && ruleSize !== size) return false;
    if (ruleFrameColor && ruleFrameColor !== frameColor) return false;
    return Boolean(ruleStyle || ruleSize || ruleFrameColor);
  }) || null;
}

function priceToTry(row, usdTry) {
  const price = Number(row?.price);
  if (!Number.isFinite(price)) return null;

  if (row?.currency === 'TRY') return price;
  if (row?.currency === 'USD' && Number.isFinite(Number(usdTry))) {
    return price * Number(usdTry);
  }

  return null;
}

export async function evaluateListingProfit(listingId, options = {}) {
  const intelligence = await getListingVariationIntelligence(listingId);
  const etsyNetRatio = Number(options?.etsy_net_ratio);
  const usdTry = Number(options?.usd_try);
  const targetProfitTry = Number(options?.target_profit_try || 0);
  const costRules = Array.isArray(options?.costs) ? options.costs : [];

  if (!(etsyNetRatio > 0 && etsyNetRatio <= 1)) {
    const error = new Error('etsy_net_ratio must be greater than 0 and at most 1');
    error.status = 400;
    throw error;
  }

  if (!(usdTry > 0)) {
    const error = new Error('usd_try must be greater than 0');
    error.status = 400;
    throw error;
  }

  const rows = intelligence.rows.map((row) => {
    const costRule = findCostRule(costRules, row);
    const grossTry = priceToTry(row, usdTry);
    const netAfterEtsyTry = Number.isFinite(grossTry)
      ? grossTry * etsyNetRatio
      : null;
    const costTry = Number(costRule?.cost_try);
    const hasCost = Number.isFinite(costTry);
    const contributionBeforeAdsTry =
      hasCost && Number.isFinite(netAfterEtsyTry)
        ? netAfterEtsyTry - costTry
        : null;
    const maxAdSpendTry =
      Number.isFinite(contributionBeforeAdsTry)
        ? contributionBeforeAdsTry - targetProfitTry
        : null;

    return {
      ...row,
      matched_cost_rule: costRule,
      gross_try: grossTry,
      net_after_etsy_try: netAfterEtsyTry,
      cost_try: hasCost ? costTry : null,
      contribution_before_ads_try: contributionBeforeAdsTry,
      target_profit_try: targetProfitTry,
      max_ad_spend_try: maxAdSpendTry,
      profitable_before_ads:
        Number.isFinite(contributionBeforeAdsTry)
          ? contributionBeforeAdsTry > 0
          : null
    };
  });

  return {
    ok: true,
    version: VARIATION_INTELLIGENCE_VERSION,
    mode: 'read_only_profit_model',
    listing_id: Number(listingId),
    assumptions: {
      etsy_net_ratio: etsyNetRatio,
      usd_try: usdTry,
      target_profit_try: targetProfitTry
    },
    matched_cost_rows: rows.filter((row) => row.matched_cost_rule).length,
    unmatched_cost_rows: rows.filter((row) => !row.matched_cost_rule).length,
    rows,
    etsy_modified: false
  };
}
