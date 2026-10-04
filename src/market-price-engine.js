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

  if (!match) {
    match = text.match(
      /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*(?:in|inch|inches)\b/i
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

function extractAllDimensions(value) {
  const text = normalizeText(value);
  const found = [];

  const cmRegex = /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*cm\b/gi;
  const inchRegex = /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*(?:"|in|inch|inches)\b/gi;

  for (const [regex, unit] of [[cmRegex, 'cm'], [inchRegex, 'in']]) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      let a = Number(match[1].replace(',', '.'));
      let b = Number(match[2].replace(',', '.'));
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (unit === 'in') {
        a *= 2.54;
        b *= 2.54;
      }
      found.push([a, b].sort((x, y) => x - y));
    }
  }

  return found;
}

function containsTargetDimensions(value, targetDimensions) {
  if (!targetDimensions) return false;
  return extractAllDimensions(value).some(
    (dimensions) => sizeMatches(targetDimensions, dimensions)
  );
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
    /\b(stretched|stretch canvas|wrapped canvas|wrapped cnvas|gallery wrap|gallery canvas|ready to hang|ready-to-hang|frameless canvas)\b/.test(text)
  ) {
    return 'stretched';
  }

  return null;
}


function detectFrameColor(value) {
  const text = normalizeText(value);
  const pairs = [
    ['dark_wood', /\b(dark wood|dark walnut)\b/],
    ['natural_wood', /\b(natural wood|natural oak|oak|wood frame|canvas wood frame)\b/],
    ['black', /\bblack\b/],
    ['white', /\bwhite\b/],
    ['gold', /\bgold\b/],
    ['silver_gray', /\b(silver gray|silver grey|silver)\b/],
    ['gray', /\b(gray|grey)\b/],
    ['walnut', /\bwalnut\b/]
  ];
  for (const [name, pattern] of pairs) {
    if (pattern.test(text)) return name;
  }
  return null;
}

function targetFromInput(variationKey, label) {
  const combined = `${variationKey || ''} ${label || ''}`;
  const dimensions = parseDimensions(combined);
  const style = detectStyle(combined);
  const frameColor = detectFrameColor(combined);

  return {
    dimensions,
    size: sizeLabel(dimensions),
    style,
    frame_color: frameColor
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

function inventoryUsdConversion(inventory, listing) {
  const visibleCurrency = String(listing?.price?.currency_code || '').toUpperCase();
  const visibleUsd = moneyToNumber(listing?.price);

  const enabled = [];
  for (const product of inventory?.products || []) {
    for (const offering of product?.offerings || []) {
      if (offering?.is_enabled === false) continue;
      const currency = String(offering?.price?.currency_code || '').toUpperCase();
      const value = moneyToNumber(offering?.price);
      if (currency && Number.isFinite(value) && value > 0) {
        enabled.push({ currency, value });
      }
    }
  }

  const currencies = [...new Set(enabled.map((item) => item.currency))];
  if (currencies.length !== 1) return null;

  const currency = currencies[0];
  if (currency === 'USD') {
    return { currency, rate: 1, source: 'native_usd' };
  }

  if (!(visibleCurrency === 'USD' && Number.isFinite(visibleUsd) && visibleUsd > 0)) {
    return null;
  }

  const minOriginal = Math.min(
    ...enabled
      .filter((item) => item.currency === currency)
      .map((item) => item.value)
  );

  if (!(Number.isFinite(minOriginal) && minOriginal > 0)) return null;

  return {
    currency,
    rate: visibleUsd / minOriginal,
    source: 'etsy_listing_currency_ratio'
  };
}

function exactOfferingCandidates(inventory, listing, target) {
  const matches = [];
  const conversion = inventoryUsdConversion(inventory, listing);
  const listingText = `${listing?.title || ''} ${listing?.description || ''}`;
  const listingStyle = detectStyle(listingText);
  const listingHasTargetSize = containsTargetDimensions(
    listingText,
    target.dimensions
  );

  for (const product of inventory?.products || []) {
    const propertyValues = product?.property_values || [];
    const propertyText = propertyValues
      .flatMap((property) => [
        property?.property_name || '',
        ...(property?.values || [])
      ])
      .join(' ');

    const productDimensions = propertyValues
      .flatMap((property) => property?.values || [])
      .flatMap((value) => extractAllDimensions(value))
      .find((dimensions) =>
        target.dimensions
          ? sizeMatches(target.dimensions, dimensions)
          : true
      );

    const fixedSizeMatch =
      !productDimensions &&
      listingHasTargetSize &&
      propertyValues.length === 0;

    if (target.dimensions && !productDimensions && !fixedSizeMatch) {
      continue;
    }

    const propertyStyle = detectStyle(propertyText);
    const resolvedStyle = propertyStyle || listingStyle;

    if (target.style && resolvedStyle && resolvedStyle !== target.style) {
      continue;
    }

    if (target.style && !resolvedStyle) {
      continue;
    }

    const propertyColor = detectFrameColor(propertyText);
    const colorMatch =
      !target.frame_color ||
      !propertyColor ||
      propertyColor === target.frame_color;

    for (const offering of product?.offerings || []) {
      if (offering?.is_enabled === false) continue;

      const rawPrice = moneyToNumber(offering?.price);
      const currency = String(offering?.price?.currency_code || '').toUpperCase();
      if (!(Number.isFinite(rawPrice) && rawPrice > 0)) continue;

      let usdPrice = null;
      let conversionSource = null;

      if (currency === 'USD') {
        usdPrice = rawPrice;
        conversionSource = 'native_usd';
      } else if (
        conversion &&
        conversion.currency === currency &&
        Number.isFinite(conversion.rate) &&
        conversion.rate > 0
      ) {
        usdPrice = rawPrice * conversion.rate;
        conversionSource = conversion.source;
      }

      if (!(Number.isFinite(usdPrice) && usdPrice > 0)) continue;

      let matchQuality =
        propertyStyle === target.style
          ? (colorMatch ? 1 : 0.92)
          : resolvedStyle === target.style
            ? 0.84
            : 0.72;

      if (fixedSizeMatch) matchQuality -= 0.04;
      if (conversionSource === 'etsy_listing_currency_ratio') matchQuality -= 0.03;

      matches.push({
        price: usdPrice,
        raw_price: rawPrice,
        raw_currency: currency,
        conversion_source: conversionSource,
        match_quality: Math.max(0.6, matchQuality),
        frame_color: propertyColor,
        size:
          sizeLabel(productDimensions) ||
          (fixedSizeMatch ? target.size : null),
        fixed_size_listing: fixedSizeMatch
      });
    }
  }

  return matches;
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

function inchLabel(dimensions) {
  if (!dimensions) return null;
  const fmt = (cm) => {
    const inches = cm / 2.54;
    const rounded = Math.round(inches * 10) / 10;
    return Math.abs(rounded - Math.round(rounded)) < 0.12
      ? String(Math.round(rounded))
      : String(rounded);
  };
  return `${fmt(dimensions[0])}x${fmt(dimensions[1])}`;
}

function stylePhrases(style) {
  if (style === 'framed') {
    return [
      'framed canvas wall art',
      'framed canvas print',
      'floating frame canvas'
    ];
  }
  if (style === 'rolled') {
    return [
      'rolled canvas print',
      'unframed canvas print',
      'unstretched canvas'
    ];
  }
  if (style === 'stretched') {
    return [
      'stretched canvas wall art',
      'gallery wrap canvas',
      'ready to hang canvas'
    ];
  }
  return ['canvas wall art'];
}

function buildSearchQueries(target) {
  const cm = target.size;
  const inch = inchLabel(target.dimensions);
  const phrases = stylePhrases(target.style);
  const queries = [];

  for (const phrase of phrases.slice(0, 2)) {
    if (cm) queries.push(`${phrase} ${cm}`);
    if (inch) queries.push(`${phrase} ${inch} inch`);
  }

  if (cm) queries.push(`canvas wall art ${cm}`);
  if (inch) queries.push(`canvas wall art ${inch} inch`);

  // Broad style searches catch listings where the target size exists only
  // inside inventory and is not written in the title/description.
  queries.push(phrases[0]);
  if (phrases[1]) queries.push(phrases[1]);
  if (phrases[2]) queries.push(phrases[2]);

  if (target.style === 'framed') {
    queries.push('large framed canvas wall art');
    queries.push('oversized framed canvas wall art');
  } else if (target.style === 'stretched') {
    queries.push('large stretched canvas wall art');
  } else if (target.style === 'rolled') {
    queries.push('large rolled canvas print');
  }

  return [...new Set(queries)].slice(0, 11);
}

function isObviouslyIrrelevant(listing) {
  const text = normalizeText(
    `${listing?.title || ''} ${listing?.description || ''}`
  );

  const blocked = [
    /digital download/,
    /instant download/,
    /printable/,
    /mockup/,
    /size guide/,
    /blank canvas/,
    /original painting/,
    /hand[- ]?painted/,
    /custom photo/,
    /personalized photo/,
    /\bpersonalized\b/,
    /custom pet/,
    /pet portrait/,
    /photo to canvas/,
    /custom canvas.*photo/,
    /set of [2-9]/,
    /set of (two|three|four|five|six|seven|eight|nine)/
  ];

  if (blocked.some((pattern) => pattern.test(text))) return true;

  if (/\bposter\b/.test(text) && !/\bcanvas\b/.test(text)) {
    return true;
  }

  return false;
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
    const listingId = Number(
      item?.listing_id ||
      item?.inventory?.listing?.listing_id ||
      0
    );
    if (!listingId) continue;
    map.set(listingId, item?.inventory ?? item);
  }

  return map;
}

function shippingMapFromBatch(batchResponse) {
  const map = new Map();
  const results = Array.isArray(batchResponse?.results)
    ? batchResponse.results
    : [];

  for (const item of results) {
    const listingId = Number(
      item?.listing_id ||
      item?.shipping_profile?.listing?.listing_id ||
      0
    );
    if (!listingId) continue;
    map.set(listingId, item?.shipping_profile ?? item);
  }

  return map;
}

async function fetchBatchInventories(listingIds) {
  const map = new Map();

  for (const ids of chunk(listingIds, 100)) {
    try {
      const batch = await etsyRequest('/listings/batch/inventory', {
        params: { listing_ids: ids }
      });
      for (const [listingId, inventory] of inventoryMapFromBatch(batch).entries()) {
        map.set(listingId, inventory);
      }
    } catch {
      // Conservative fallback: do not fabricate exact variation data.
    }
  }

  return map;
}

async function fetchBatchShipping(listingIds) {
  const map = new Map();

  for (const ids of chunk(listingIds, 100)) {
    try {
      const batch = await etsyRequest('/listings/batch/shipping', {
        params: { listing_ids: ids }
      });
      for (const [listingId, profile] of shippingMapFromBatch(batch).entries()) {
        map.set(listingId, profile);
      }
    } catch {
      // Shipping is an enrichment signal; inventory comparison can still proceed.
    }
  }

  return map;
}

function shippingCostUsd(profile, buyerCountry) {
  if (!profile) return null;

  const destinations = Array.isArray(profile?.shipping_profile_destinations)
    ? profile.shipping_profile_destinations
    : [];

  const country = String(buyerCountry || '').toUpperCase();
  const exact = destinations.find(
    (destination) =>
      String(destination?.destination_country_iso || '').toUpperCase() === country
  );

  if (!exact) return null;

  const primary = exact?.primary_cost;
  const currency = String(primary?.currency_code || '').toUpperCase();
  if (currency && currency !== 'USD') return null;

  const cost = moneyToNumber(primary);
  if (!Number.isFinite(cost) || cost < 0) return null;

  const origin = String(profile?.origin_country_iso || '').toUpperCase();
  const fee =
    origin && origin === country
      ? Number(profile?.domestic_handling_fee || 0)
      : Number(profile?.international_handling_fee || 0);

  return cost + (Number.isFinite(fee) ? Math.max(0, fee) : 0);
}

function capPerShop(references, maxPerShop = 2) {
  const counts = new Map();
  const selected = [];

  for (const reference of references) {
    const shopId = Number(reference?.shop_id || 0);
    if (!shopId) continue;

    const count = counts.get(shopId) || 0;
    if (count >= maxPerShop) continue;

    counts.set(shopId, count + 1);
    selected.push(reference);
  }

  return selected;
}

function filterPriceOutliers(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 8) return sorted;

  const trim = sorted.length >= 10
    ? Math.floor(sorted.length * 0.10)
    : 0;

  const trimmed =
    trim > 0
      ? sorted.slice(trim, sorted.length - trim)
      : sorted;

  if (trimmed.length < 6) return trimmed;

  const q1 = percentile(trimmed, 0.25);
  const q3 = percentile(trimmed, 0.75);
  const iqr = q3 - q1;

  if (!(Number.isFinite(iqr) && iqr > 0)) return trimmed;

  const low = q1 - 1.5 * iqr;
  const high = q3 + 1.5 * iqr;

  return trimmed.filter((value) => value >= low && value <= high);
}

function confidenceDetails({
  exactCount,
  distinctShopCount,
  shippingCoverage,
  priceValues,
  averageMatchQuality
}) {
  const exactScore = Math.min(40, exactCount * 3);
  const shopScore = Math.min(25, distinctShopCount * 4);

  const med = median(priceValues);
  const q1 = percentile(priceValues, 0.25);
  const q3 = percentile(priceValues, 0.75);
  const dispersion =
    Number.isFinite(med) && med > 0 && Number.isFinite(q1) && Number.isFinite(q3)
      ? (q3 - q1) / med
      : 1;

  const consistencyScore =
    dispersion <= 0.30
      ? 20
      : dispersion <= 0.45
        ? 16
        : dispersion <= 0.60
          ? 11
          : dispersion <= 0.80
            ? 6
            : 0;

  const relevanceScore = Math.min(
    15,
    Math.max(0, Number(averageMatchQuality || 0)) * 15
  );

  const score = Math.min(
    100,
    Math.round(
      exactScore +
      shopScore +
      consistencyScore +
      relevanceScore
    )
  );

  let level = 'LOW';

  if (
    exactCount >= 20 &&
    distinctShopCount >= 10 &&
    score >= 85
  ) {
    level = 'VERY_HIGH';
  } else if (
    exactCount >= 10 &&
    distinctShopCount >= 6 &&
    score >= 70
  ) {
    level = 'HIGH';
  } else if (
    exactCount >= 4 &&
    distinctShopCount >= 3 &&
    score >= 45
  ) {
    level = 'MEDIUM';
  }

  return {
    score,
    level,
    dispersion_ratio: round2(dispersion),
    components: {
      exact_matches: round2(exactScore),
      distinct_shops: round2(shopScore),
      price_consistency: round2(consistencyScore),
      product_relevance: round2(relevanceScore)
    },
    shipping_coverage_pct: round2(
      Math.max(0, Number(shippingCoverage || 0)) * 100
    )
  };
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
  searchLimit = 300
}) {
  const target = targetFromInput(variationKey, label);
  const searchQueries = buildSearchQueries(target);
  const ownShopId = Number(await getShopId());
  const overallLimit = Math.min(
    Math.max(Number(searchLimit) || 300, 80),
    300
  );
  const perQueryLimit = Math.min(
    100,
    Math.max(60, Math.ceil(overallLimit / Math.max(searchQueries.length, 1)))
  );

  const searches = await mapWithConcurrency(
    searchQueries,
    2,
    async (keywords) => {
      const response = await etsyPublicRequest('/listings/active', {
        params: {
          keywords,
          limit: perQueryLimit,
          sort_on: 'score',
          currency: 'USD',
          buyer_country: buyerCountry,
          is_safe: true
        }
      });

      return {
        keywords,
        listings: Array.isArray(response?.results)
          ? response.results
          : []
      };
    }
  );

  const candidateMap = new Map();

  for (const search of searches) {
    for (const listing of search.listings) {
      const listingId = Number(listing?.listing_id || 0);
      if (!listingId) continue;
      if (Number(listing?.shop_id) === ownShopId) continue;
      if (isObviouslyIrrelevant(listing)) continue;

      if (!candidateMap.has(listingId)) {
        candidateMap.set(listingId, {
          ...listing,
          matched_queries: [search.keywords]
        });
      } else {
        candidateMap.get(listingId).matched_queries.push(search.keywords);
      }
    }
  }

  const candidates = [...candidateMap.values()]
    .sort(
      (a, b) =>
        (b?.matched_queries?.length || 0) -
        (a?.matched_queries?.length || 0)
    )
    .slice(0, overallLimit);

  const listingIds = candidates.map((listing) => Number(listing.listing_id));
  const [inventories, shippingProfiles] = await Promise.all([
    fetchBatchInventories(listingIds),
    fetchBatchShipping(listingIds)
  ]);

  const exactReferences = [];

  for (const listing of candidates) {
    const listingId = Number(listing?.listing_id || 0);
    const inventory = inventories.get(listingId);
    if (!inventory) continue;

    const offerings = exactOfferingCandidates(inventory, listing, target);
    if (!offerings.length) continue;

    const exactPrice = median(offerings.map((item) => item.price));
    const averageMatchQuality = average(
      offerings.map((item) => item.match_quality)
    );
    const shippingCost = shippingCostUsd(
      shippingProfiles.get(listingId),
      buyerCountry
    );

    exactReferences.push({
      listing_id: listingId,
      shop_id: Number(listing?.shop_id || 0),
      title: String(listing?.title || ''),
      url: String(listing?.url || ''),
      exact_price: round2(exactPrice),
      shipping_usd: round2(shippingCost),
      effective_price:
        Number.isFinite(exactPrice) && Number.isFinite(shippingCost)
          ? round2(exactPrice + shippingCost)
          : null,
      match_quality: round2(averageMatchQuality),
      currency_conversion:
        offerings.some((item) => item.conversion_source === 'etsy_listing_currency_ratio')
          ? 'etsy_listing_currency_ratio'
          : 'native_usd',
      fixed_size_listing:
        offerings.some((item) => item.fixed_size_listing === true),
      query_hits: listing?.matched_queries?.length || 0,
      source: 'exact_variation'
    });
  }

  const ranked = exactReferences.sort((a, b) => {
    const qualityDiff =
      Number(b.match_quality || 0) -
      Number(a.match_quality || 0);
    if (Math.abs(qualityDiff) > 0.001) return qualityDiff;
    return Number(b.query_hits || 0) - Number(a.query_hits || 0);
  });

  const shopCapped = capPerShop(ranked, 2);
  const distinctShopCount = new Set(
    shopCapped.map((reference) => reference.shop_id)
  ).size;

  const shippingCovered = shopCapped.filter(
    (reference) => Number.isFinite(reference.effective_price)
  );
  const shippingCoverage =
    shopCapped.length
      ? shippingCovered.length / shopCapped.length
      : 0;

  const useEffectivePrice =
    shippingCoverage >= 0.70 &&
    shippingCovered.length >= 6;

  const sourceValues = (
    useEffectivePrice
      ? shippingCovered.map((reference) => reference.effective_price)
      : shopCapped.map((reference) => reference.exact_price)
  ).filter((value) => Number.isFinite(value) && value > 0);

  const cleanValues = filterPriceOutliers(sourceValues);
  const avgMatchQuality = average(
    shopCapped.map((reference) => reference.match_quality)
  );

  const confidence = confidenceDetails({
    exactCount: shopCapped.length,
    distinctShopCount,
    shippingCoverage,
    priceValues: cleanValues,
    averageMatchQuality: avgMatchQuality
  });

  return {
    target,
    search_queries: searchQueries,
    candidate_count: candidates.length,
    exact_references_before_shop_cap: exactReferences.length,
    references: shopCapped,
    exact: cleanValues,
    visible: candidates
      .map((listing) => moneyToNumber(listing?.price))
      .filter((value) => Number.isFinite(value) && value > 0),
    distinct_shop_count: distinctShopCount,
    shipping_coverage: shippingCoverage,
    reference_mode:
      useEffectivePrice
        ? 'effective_delivered_price'
        : 'exact_item_price',
    confidence
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
  minReferences = 10,
  searchLimit = 180
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
  const exactCount = data.references.length;
  const exactMedian = median(data.exact);
  const exactAverage = trimmedAverage(data.exact);
  const visibleMedian = median(data.visible);
  const visibleAverage = trimmedAverage(data.visible);

  const confidence = data.confidence || {
    score: 0,
    level: 'LOW'
  };

  const strongMarket =
    (confidence.level === 'HIGH' || confidence.level === 'VERY_HIGH') &&
    exactCount >= Math.max(10, Number(minReferences) || 10) &&
    Number(data.distinct_shop_count || 0) >= 6;

  const marketReference = strongMarket
    ? exactMedian
    : null;

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
    search_keywords: data.search_queries,
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
      confidence: confidence.level,
      confidence_score: Number(confidence.score || 0),
      confidence_components: confidence.components || {},
      dispersion_ratio: confidence.dispersion_ratio,
      candidate_count: Number(data.candidate_count || 0),
      exact_reference_count: exactCount,
      exact_reference_count_before_shop_cap:
        Number(data.exact_references_before_shop_cap || 0),
      distinct_shop_count: Number(data.distinct_shop_count || 0),
      shipping_coverage_pct: round2(
        Number(data.shipping_coverage || 0) * 100
      ),
      reference_mode: data.reference_mode,
      exact_median: round2(exactMedian),
      exact_average: round2(exactAverage),
      visible_median: round2(visibleMedian),
      visible_average: round2(visibleAverage),
      reference_price: round2(marketReference),
      p25: round2(percentile(data.exact, 0.25)),
      p50: round2(percentile(data.exact, 0.50)),
      p75: round2(percentile(data.exact, 0.75)),
      references: data.references.slice(0, 20)
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
