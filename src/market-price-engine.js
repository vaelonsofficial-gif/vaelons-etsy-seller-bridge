import {
  etsyRequest,
  etsyPublicRequest,
  getShopId
} from './etsy.js';

const CACHE_TTL_MS = 15 * 60 * 1000;
const cache = new Map();

function moneyToNumber(price) {
  if (price == null) return null;
  if (typeof price === 'number') return Number(price);
  if (
    typeof price === 'object' &&
    Number.isFinite(Number(price.amount)) &&
    Number.isFinite(Number(price.divisor)) &&
    Number(price.divisor) !== 0
  ) {
    return Number(price.amount) / Number(price.divisor);
  }
  const n = Number(price);
  return Number.isFinite(n) ? n : null;
}

function normalizeText(value) {
  return String(value ?? '')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/[“”″]/g, '"')
    .replace(/[×✕*]/g, 'x')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseDimensions(value) {
  const text = normalizeText(value);

  let match = text.match(
    /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*cm\b/i
  );

  let unit = 'cm';

  if (!match) {
    match = text.match(
      /(\d+(?:[.,]\d+)?)\s*"\s*x\s*(\d+(?:[.,]\d+)?)\s*"/i
    );
    unit = 'in';
  }

  if (!match) return null;

  let a = Number(match[1].replace(',', '.'));
  let b = Number(match[2].replace(',', '.'));

  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  if (unit === 'in') {
    a *= 2.54;
    b *= 2.54;
  }

  return [a, b].sort((x, y) => x - y);
}

function sizeLabel(dimensions) {
  if (!dimensions) return null;
  const fmt = (n) =>
    Math.abs(n - Math.round(n)) < 0.05
      ? String(Math.round(n))
      : String(Math.round(n * 10) / 10);
  return `${fmt(dimensions[0])}x${fmt(dimensions[1])}cm`;
}

function sizeMatches(target, candidate) {
  if (!target || !candidate) return false;

  return target.every((value, index) => {
    const other = candidate[index];
    const absolute = Math.abs(value - other);
    const relative = absolute / Math.max(value, other, 1);
    return absolute <= 3 || relative <= 0.055;
  });
}

function detectStyle(value) {
  const text = normalizeText(value);

  if (/\b(rolled|roll-up|roll up|unstretched|unframed canvas|canvas roll)\b/.test(text)) {
    return 'rolled';
  }

  if (
    /\b(framed|frame|floater|floating frame|wood frame|framed canvas)\b/.test(text) &&
    !/\bunframed\b/.test(text)
  ) {
    return 'framed';
  }

  if (
    /\b(stretched|stretch canvas|gallery wrap|gallery canvas|ready to hang|ready-to-hang|frameless canvas)\b/.test(text)
  ) {
    return 'stretched';
  }

  return null;
}

function targetFromInput(variationKey, label) {
  const combined = `${variationKey || ''} ${label || ''}`;
  const dimensions = parseDimensions(combined);
  const style = detectStyle(combined);

  return {
    dimensions,
    size: sizeLabel(dimensions),
    style
  };
}

function productText(product, listing) {
  const values = (product?.property_values || [])
    .flatMap((property) => [
      property?.property_name || '',
      ...(property?.values || [])
    ])
    .join(' ');

  return `${values} ${listing?.title || ''} ${listing?.description || ''}`;
}

function exactOfferingPrices(inventory, listing, target) {
  const prices = [];

  for (const product of inventory?.products || []) {
    const productDimensions = (product?.property_values || [])
      .flatMap((property) => property?.values || [])
      .map(parseDimensions)
      .find(Boolean);

    if (target.dimensions && !sizeMatches(target.dimensions, productDimensions)) {
      continue;
    }

    const style = detectStyle(productText(product, listing));

    if (target.style && style && style !== target.style) {
      continue;
    }

    if (target.style && !style) {
      const listingStyle = detectStyle(
        `${listing?.title || ''} ${listing?.description || ''}`
      );
      if (listingStyle && listingStyle !== target.style) continue;
    }

    for (const offering of product?.offerings || []) {
      if (offering?.is_enabled === false) continue;
      const currency = String(
        offering?.price?.currency_code ||
        listing?.price?.currency_code ||
        ''
      ).toUpperCase();

      if (currency && currency !== 'USD') continue;

      const price = moneyToNumber(offering?.price);
      if (Number.isFinite(price) && price > 0) prices.push(price);
    }
  }

  return prices;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function trimmedAverage(values, trimPct = 0.2) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const trim = Math.floor(sorted.length * trimPct);
  const kept =
    sorted.length - trim * 2 >= 3
      ? sorted.slice(trim, sorted.length - trim)
      : sorted;
  return average(kept);
}

function percentile(values, pct) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * pct;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function buildKeywords(target) {
  const styleText =
    target.style === 'framed'
      ? 'framed canvas wall art'
      : target.style === 'rolled'
        ? 'rolled unframed canvas print'
        : target.style === 'stretched'
          ? 'stretched canvas wall art ready to hang'
          : 'canvas wall art';

  return [styleText, target.size].filter(Boolean).join(' ');
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limit), items.length || 1) },
      () => run()
    )
  );

  return results;
}

async function competitorReferences({
  variationKey,
  label,
  buyerCountry = 'US',
  searchLimit = 20
}) {
  const target = targetFromInput(variationKey, label);
  const keywords = buildKeywords(target);
  const ownShopId = Number(await getShopId());

  const search = await etsyPublicRequest('/listings/active', {
    params: {
      keywords,
      limit: Math.min(Math.max(Number(searchLimit) || 20, 5), 50),
      sort_on: 'score',
      currency: 'USD',
      buyer_country: buyerCountry,
      is_safe: true
    }
  });

  const listings = (search?.results || [])
    .filter((listing) => Number(listing?.shop_id) !== ownShopId)
    .slice(0, Math.min(Math.max(Number(searchLimit) || 20, 5), 50));

  const enriched = await mapWithConcurrency(
    listings.slice(0, 12),
    3,
    async (listing) => {
      let exactPrices = [];

      try {
        const inventory = await etsyRequest(
          `/listings/${listing.listing_id}/inventory`
        );
        exactPrices = exactOfferingPrices(inventory, listing, target);
      } catch {
        exactPrices = [];
      }

      const exactPrice = exactPrices.length
        ? median(exactPrices)
        : null;

      return {
        listing_id: Number(listing?.listing_id),
        shop_id: Number(listing?.shop_id),
        title: String(listing?.title || ''),
        url: String(listing?.url || ''),
        exact_price: round2(exactPrice),
        visible_price: round2(moneyToNumber(listing?.price)),
        source: Number.isFinite(exactPrice)
          ? 'exact_variation'
          : 'visible_listing'
      };
    }
  );

  const remaining = listings.slice(12).map((listing) => ({
    listing_id: Number(listing?.listing_id),
    shop_id: Number(listing?.shop_id),
    title: String(listing?.title || ''),
    url: String(listing?.url || ''),
    exact_price: null,
    visible_price: round2(moneyToNumber(listing?.price)),
    source: 'visible_listing'
  }));

  const references = [...enriched, ...remaining];
  const exact = references
    .map((reference) => reference.exact_price)
    .filter((value) => Number.isFinite(value) && value > 0);
  const visible = references
    .map((reference) => reference.visible_price)
    .filter((value) => Number.isFinite(value) && value > 0);

  return {
    target,
    keywords,
    references,
    exact,
    visible
  };
}

export async function analyzeMarketPrice({
  variationKey,
  label,
  currentPrice,
  costUsd,
  minMarginPct = 20,
  marketAdjustmentPct = 0,
  maxStepPct = 5,
  etsyNetRatio = 200 / 249,
  buyerCountry = 'US',
  minReferences = 4,
  searchLimit = 20
}) {
  const current = Number(currentPrice);
  const cost = Number(costUsd);
  const minMargin = Number(minMarginPct) / 100;
  const marketAdjustment = Number(marketAdjustmentPct) / 100;
  const maxStep = Math.abs(Number(maxStepPct)) / 100;
  const netRatio = Number(etsyNetRatio);

  if (!(current > 0)) {
    const error = new Error('currentPrice must be greater than 0');
    error.status = 400;
    throw error;
  }

  if (!(cost > 0)) {
    const error = new Error('costUsd must be greater than 0');
    error.status = 400;
    throw error;
  }

  if (!(netRatio > 0 && netRatio <= 1)) {
    const error = new Error('etsyNetRatio must be greater than 0 and at most 1');
    error.status = 400;
    throw error;
  }

  if (!(minMargin >= 0 && minMargin < netRatio)) {
    const error = new Error('Minimum margin must be lower than Etsy net ratio');
    error.status = 400;
    throw error;
  }

  const target = targetFromInput(variationKey, label);
  const cacheKey = JSON.stringify({
    variationKey,
    label,
    buyerCountry,
    searchLimit
  });

  let market = cache.get(cacheKey);

  if (!market || Date.now() - market.created_at > CACHE_TTL_MS) {
    market = {
      created_at: Date.now(),
      value: await competitorReferences({
        variationKey,
        label,
        buyerCountry,
        searchLimit
      })
    };
    cache.set(cacheKey, market);
  }

  const data = market.value;
  const exactCount = data.exact.length;
  const exactMedian = median(data.exact);
  const exactAverage = trimmedAverage(data.exact);
  const visibleMedian = median(data.visible);
  const visibleAverage = trimmedAverage(data.visible);

  const strongMarket =
    exactCount >= Math.max(2, Number(minReferences) || 4);

  const marketReference = strongMarket
    ? exactMedian
    : visibleMedian;

  const profitFloor = cost / (netRatio - minMargin);
  const marketTarget = Number.isFinite(marketReference)
    ? marketReference * (1 + marketAdjustment)
    : null;

  const marketEligible =
    strongMarket &&
    Number.isFinite(marketTarget);

  const belowProfitFloor =
    current < profitFloor - 0.01;

  let recommendationSource = 'HOLD_INSUFFICIENT_MARKET';
  let rawRecommended = current;

  if (marketEligible) {
    rawRecommended = Math.max(profitFloor, marketTarget);
    recommendationSource =
      marketTarget >= profitFloor
        ? 'MARKET'
        : 'PROFIT_FLOOR';
  } else if (belowProfitFloor) {
    rawRecommended = profitFloor;
    recommendationSource = 'PROFIT_FLOOR';
  }

  const lowerStep = current * (1 - maxStep);
  const upperStep = current * (1 + maxStep);

  let nextPrice = current;

  if (recommendationSource === 'PROFIT_FLOOR' && belowProfitFloor) {
    // Minimum margin protection may override the normal market step limit.
    nextPrice = profitFloor;
  } else if (recommendationSource === 'MARKET') {
    nextPrice = clamp(rawRecommended, lowerStep, upperStep);
    nextPrice = Math.max(nextPrice, profitFloor);
  }

  nextPrice = round2(nextPrice);
  rawRecommended = round2(rawRecommended);

  const estimatedMargin =
    nextPrice > 0
      ? (nextPrice * netRatio - cost) / nextPrice
      : null;

  const changePct =
    current > 0
      ? ((nextPrice - current) / current) * 100
      : null;

  const marketGapPct =
    Number.isFinite(marketReference) && marketReference > 0
      ? ((current - marketReference) / marketReference) * 100
      : null;

  let action = 'HOLD';

  if (current < profitFloor - 0.01) {
    action = 'RAISE_FOR_MARGIN';
  } else if (changePct > 0.25) {
    action = 'RAISE';
  } else if (changePct < -0.25) {
    action = 'LOWER';
  }

  return {
    ok: true,
    read_only: true,
    variation_key: variationKey,
    label,
    target: data.target,
    search_keywords: data.keywords,
    settings: {
      min_margin_pct: Number(minMarginPct),
      market_adjustment_pct: Number(marketAdjustmentPct),
      max_step_pct: Number(maxStepPct),
      etsy_net_ratio: netRatio,
      buyer_country: buyerCountry,
      min_references: Number(minReferences)
    },
    inputs: {
      current_price: round2(current),
      cost_usd: round2(cost)
    },
    market: {
      confidence: strongMarket ? 'HIGH' : exactCount >= 2 ? 'MEDIUM' : 'LOW',
      exact_reference_count: exactCount,
      visible_reference_count: data.visible.length,
      exact_median: round2(exactMedian),
      exact_average: round2(exactAverage),
      visible_median: round2(visibleMedian),
      visible_average: round2(visibleAverage),
      reference_price: round2(marketReference),
      p25: round2(percentile(strongMarket ? data.exact : data.visible, 0.25)),
      p75: round2(percentile(strongMarket ? data.exact : data.visible, 0.75)),
      references: data.references.slice(0, 12)
    },
    recommendation: {
      profit_floor_price: round2(profitFloor),
      market_target_price: round2(marketTarget),
      raw_recommended_price: rawRecommended,
      next_price: nextPrice,
      change_pct: round2(changePct),
      market_gap_pct: round2(marketGapPct),
      estimated_margin_pct: round2(
        Number.isFinite(estimatedMargin)
          ? estimatedMargin * 100
          : null
      ),
      action,
      source: recommendationSource,
      market_eligible: marketEligible,
      reason:
        recommendationSource === 'MARKET'
          ? 'Exact Etsy variation market comparison + profit floor + safe step'
          : recommendationSource === 'PROFIT_FLOOR'
            ? 'Minimum profit margin protection; not a market-price recommendation'
            : 'Insufficient exact Etsy variation references; current price held'
    },
    etsy_modified: false
  };
}
