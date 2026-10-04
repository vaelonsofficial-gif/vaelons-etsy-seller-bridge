import {
  etsyRequest,
  getShopId
} from './etsy.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function round2(value) {
  return Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : 0;
}

function text(value) {
  return String(value ?? '')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function chunk(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) {
    result.push(values.slice(i, i + size));
  }
  return result;
}

async function fetchAllActiveListings(limit = 500) {
  const shopId = await getShopId();
  const rows = [];
  let offset = 0;
  let total = null;

  while (rows.length < limit) {
    const page = await etsyRequest(
      `/shops/${shopId}/listings`,
      {
        params: {
          state: 'active',
          limit: 100,
          offset
        }
      }
    );

    const results = Array.isArray(page?.results)
      ? page.results
      : [];

    if (total === null) {
      total = Number(page?.count ?? results.length);
    }

    rows.push(...results);

    if (
      results.length < 100 ||
      rows.length >= total
    ) {
      break;
    }

    offset += results.length;
  }

  return rows.slice(0, limit);
}

function enrichedListingMap(batchResponse) {
  const map = new Map();
  const results = Array.isArray(batchResponse?.results)
    ? batchResponse.results
    : [];

  for (const row of results) {
    const listingId = Number(row?.listing_id || 0);
    if (!listingId) continue;
    map.set(listingId, row);
  }

  return map;
}

async function enrichListings(listings) {
  const map = new Map();

  for (const ids of chunk(
    listings.map((listing) => Number(listing.listing_id)),
    100
  )) {
    const batch = await etsyRequest(
      '/listings/batch/shipping',
      {
        params: {
          listing_ids: ids
        }
      }
    );

    for (const [listingId, row] of enrichedListingMap(batch).entries()) {
      map.set(listingId, row);
    }
  }

  return listings.map((listing) => (
    map.get(Number(listing.listing_id)) ||
    listing
  ));
}

function daysActive(listing) {
  const timestamp = Number(
    listing?.original_creation_timestamp ||
    listing?.created_timestamp ||
    listing?.creation_timestamp ||
    0
  );

  if (!timestamp) return 30;

  const createdMs = timestamp * 1000;
  return Math.max(
    1,
    (Date.now() - createdMs) / DAY_MS
  );
}

function titleQuality(title) {
  const clean = text(title);
  const words = clean
    .split(/\s+/)
    .filter(Boolean);

  let score = 0;

  if (clean.length >= 45 && clean.length <= 130) score += 2;
  else if (clean.length >= 30 && clean.length <= 140) score += 1;

  if (words.length >= 5 && words.length <= 18) score += 2;
  else if (words.length >= 4 && words.length <= 24) score += 1;

  const normalizedWords = words
    .map((word) =>
      word
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
    )
    .filter((word) => word.length >= 4);

  const unique = new Set(normalizedWords);
  const repetition =
    normalizedWords.length
      ? 1 - unique.size / normalizedWords.length
      : 1;

  if (repetition <= 0.15) score += 1;

  return clamp(score, 0, 5);
}

function descriptionQuality(description) {
  const clean = text(description).toLowerCase();
  let score = 0;

  if (clean.length >= 700) score += 2;
  else if (clean.length >= 350) score += 1;

  const productTerms = [
    'canvas',
    'frame',
    'framed',
    'stretched',
    'rolled',
    'ready to hang',
    'ready-to-hang'
  ];

  const trustTerms = [
    'shipping',
    'tracking',
    'trackable',
    'replacement',
    'damaged',
    'package',
    'packaging',
    'production time',
    'delivery'
  ];

  if (productTerms.some((term) => clean.includes(term))) score += 1;

  const trustCount = trustTerms.filter(
    (term) => clean.includes(term)
  ).length;

  if (trustCount >= 3) score += 2;
  else if (trustCount >= 1) score += 1;

  return clamp(score, 0, 5);
}

function fulfillmentScore(listing) {
  let score = 0;

  const processingMax = Number(listing?.processing_max || 0);

  if (processingMax > 0 && processingMax <= 3) score += 5;
  else if (processingMax > 0 && processingMax <= 5) score += 4;
  else if (processingMax > 0 && processingMax <= 7) score += 2;

  if (listing?.return_policy_id) score += 4;

  if (
    listing?.shipping_profile_id ||
    listing?.shipping_profile
  ) {
    score += 4;
  }

  const clean = text(listing?.description).toLowerCase();

  if (
    clean.includes('ready to hang') ||
    clean.includes('ready-to-hang')
  ) {
    score += 3;
  }

  const trustTerms = [
    'tracking',
    'trackable',
    'replacement',
    'damaged',
    'packaging',
    'fedex',
    'ups',
    'dhl'
  ];

  const count = trustTerms.filter(
    (term) => clean.includes(term)
  ).length;

  if (count >= 3) score += 4;
  else if (count >= 1) score += 2;

  return clamp(score, 0, 20);
}

function qualityScore(listing) {
  const imageCount = Array.isArray(listing?.images)
    ? listing.images.length
    : 0;
  const tagCount = Array.isArray(listing?.tags)
    ? listing.tags.filter(Boolean).length
    : 0;

  const imageScore = clamp(imageCount, 0, 10);
  const tagScore = clamp((tagCount / 13) * 5, 0, 5);
  const titleScore = titleQuality(listing?.title);
  const descriptionScore = descriptionQuality(listing?.description);

  let structureScore = 0;
  if (listing?.taxonomy_id) structureScore += 2;
  if (listing?.has_variations) structureScore += 2;
  if (listing?.listing_type === 'physical') structureScore += 1;

  return {
    total: round2(
      imageScore +
      tagScore +
      titleScore +
      descriptionScore +
      structureScore
    ),
    image_count: imageCount,
    tag_count: tagCount,
    image_score: round2(imageScore),
    tag_score: round2(tagScore),
    title_score: round2(titleScore),
    description_score: round2(descriptionScore),
    structure_score: round2(structureScore)
  };
}

function percentileRanks(values) {
  const safe = values.map((value) =>
    Number.isFinite(value) ? value : 0
  );

  if (!safe.length) return [];

  const max = Math.max(...safe);
  const min = Math.min(...safe);

  if (max <= 0) {
    return safe.map(() => 0);
  }

  if (max === min) {
    return safe.map(() => 50);
  }

  const indexed = safe
    .map((value, index) => ({ value, index }))
    .sort((a, b) => a.value - b.value);

  const ranks = new Array(safe.length).fill(0);

  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (
      j + 1 < indexed.length &&
      indexed[j + 1].value === indexed[i].value
    ) {
      j += 1;
    }

    const averagePosition = (i + j) / 2;
    const rank =
      (averagePosition / (indexed.length - 1)) * 100;

    for (let k = i; k <= j; k += 1) {
      ranks[indexed[k].index] = rank;
    }

    i = j + 1;
  }

  return ranks;
}

function baseMetrics(listing) {
  const days = daysActive(listing);
  const views = Math.max(0, Number(listing?.views || 0));
  const favorites = Math.max(
    0,
    Number(listing?.num_favorers || 0)
  );

  return {
    listing_id: Number(listing?.listing_id || 0),
    title: text(listing?.title),
    url: String(listing?.url || ''),
    days_active: round2(days),
    views,
    favorites,
    views_per_day: round2(views / days),
    favorites_per_day: round2(favorites / days),
    favorite_rate_pct:
      views > 0
        ? round2((favorites / views) * 100)
        : 0,
    quality: qualityScore(listing),
    fulfillment_score: fulfillmentScore(listing),
    listing
  };
}

function salesAction(row, availability) {
  const score = row.sales_score;
  const demand = row.scores.demand;
  const quality = row.scores.quality;
  const trust = row.scores.trust;
  const favoriteRank = row.percentiles.favorites_per_day;
  const favoriteRateRank = row.percentiles.favorite_rate;

  if (
    row.favorites > 0 &&
    favoriteRank >= 70 &&
    score >= 68 &&
    quality >= 20 &&
    trust >= 12
  ) {
    return {
      code: 'HERO',
      label: availability.views
        ? 'HERO — TRAFİĞİ BÜYÜT'
        : 'HERO ADAYI — FAVORİ SİNYALİ GÜÇLÜ',
      priority: 1,
      reason: availability.views
        ? 'Talep, ilgi ve listing kalitesi birlikte güçlü.'
        : 'Etsy views verisi kapalı; mağaza içindeki gerçek favori hızı ve listing kalitesi güçlü.'
    };
  }

  if (
    availability.views &&
    row.percentiles.views_per_day >= 60 &&
    favoriteRateRank < 40
  ) {
    return {
      code: 'ENGAGEMENT_FIX',
      label: 'ÜRÜN SAYFASINI GÜÇLENDİR',
      priority: 2,
      reason:
        'Ürün görüntüleniyor ancak favoriye dönüşme oranı mağaza ortalamasının altında.'
    };
  }

  if (
    quality < 20 ||
    trust < 12
  ) {
    return {
      code: 'LISTING_FIX',
      label: 'LISTINGİ DÜZELT',
      priority: 3,
      reason:
        'SEO/açıklama/teslimat-güven sinyallerinden biri satış için zayıf.'
    };
  }

  if (
    row.favorites > 0 &&
    demand >= 12
  ) {
    return {
      code: 'GROW_CANDIDATE',
      label: 'BÜYÜME ADAYI — TEST ET',
      priority: 2,
      reason:
        'Gerçek favori sinyali var; Hero seviyesine çıkması için kontrollü trafik testi uygun.'
    };
  }

  if (
    !availability.views &&
    row.favorites === 0 &&
    quality >= 22 &&
    trust >= 14
  ) {
    return {
      code: 'VISIBILITY_UNKNOWN',
      label: 'GÖRÜNÜRLÜK VERİSİ YETERSİZ',
      priority: 4,
      reason:
        'Listing altyapısı iyi ancak Etsy API views/impressions vermediği için trafik sorunu doğrulanamıyor.'
    };
  }

  if (score >= 55) {
    return {
      code: 'WATCH',
      label: 'İZLE / TEST ET',
      priority: 4,
      reason:
        'Orta potansiyel var; daha güçlü satış veya trafik verisi gelmeden agresif reklam ölçeklenmemeli.'
    };
  }

  return {
    code: 'LOW_PRIORITY',
    label: 'REKLAMI BÜYÜTME',
    priority: 5,
    reason:
      'Mevcut güvenli veride güçlü ilgi sinyali yok; önce Hero ve büyüme adaylarına kaynak ayır.'
  };
}

export async function scanSalesEngine({
  listingLimit = 500,
  heroLimit = 25
} = {}) {
  const base = await fetchAllActiveListings(
    clamp(Number(listingLimit) || 500, 1, 500)
  );

  const listings = await enrichListings(base);
  const metrics = listings.map(baseMetrics);

  const availability = {
    views: metrics.some((row) => row.views > 0),
    images: metrics.some(
      (row) => row.quality.image_count > 0
    ),
    favorites: metrics.some((row) => row.favorites > 0)
  };

  const viewsPerDayRanks = percentileRanks(
    metrics.map((row) => row.views_per_day)
  );
  const favoritesPerDayRanks = percentileRanks(
    metrics.map((row) => row.favorites_per_day)
  );
  const favoriteRateRanks = percentileRanks(
    metrics.map((row) => row.favorite_rate_pct)
  );
  const viewsRanks = percentileRanks(
    metrics.map((row) => row.views)
  );
  const favoriteRanks = percentileRanks(
    metrics.map((row) => row.favorites)
  );

  const rows = metrics.map((row, index) => {
    const demand = availability.views
      ? (
          (viewsPerDayRanks[index] / 100) * 18 +
          (favoritesPerDayRanks[index] / 100) * 8 +
          (viewsRanks[index] / 100) * 4
        )
      : (
          (favoritesPerDayRanks[index] / 100) * 20 +
          (favoriteRanks[index] / 100) * 10
        );

    const interest = availability.views
      ? (
          (favoriteRateRanks[index] / 100) * 15 +
          (favoriteRanks[index] / 100) * 5
        )
      : (
          row.favorites > 0
            ? Math.min(
                20,
                Math.log1p(row.favorites) * 8
              )
            : 0
        );

    const quality = availability.images
      ? row.quality.total
      : Math.min(30, row.quality.total + 5);

    const trust = row.fulfillment_score;

    const salesScore = round2(
      clamp(
        demand +
        interest +
        quality +
        trust,
        0,
        100
      )
    );

    const result = {
      listing_id: row.listing_id,
      title: row.title,
      url: row.url,
      days_active: row.days_active,
      views: row.views,
      favorites: row.favorites,
      views_per_day: row.views_per_day,
      favorites_per_day: row.favorites_per_day,
      favorite_rate_pct: row.favorite_rate_pct,
      sales_score: salesScore,
      scores: {
        demand: round2(demand),
        interest: round2(interest),
        quality: round2(quality),
        trust: round2(trust)
      },
      percentiles: {
        views_per_day: round2(viewsPerDayRanks[index]),
        favorites_per_day: round2(favoritesPerDayRanks[index]),
        favorite_rate: round2(favoriteRateRanks[index])
      },
      listing_health: {
        image_count: row.quality.image_count,
        tag_count: row.quality.tag_count,
        title_score: row.quality.title_score,
        description_score: row.quality.description_score,
        processing_max:
          Number(row.listing?.processing_max || 0) || null,
        has_return_policy:
          Boolean(row.listing?.return_policy_id),
        has_shipping_profile:
          Boolean(
            row.listing?.shipping_profile_id ||
            row.listing?.shipping_profile
          )
      }
    };

    return {
      ...result,
      action: salesAction(result, availability)
    };
  });

  rows.sort(
    (a, b) =>
      b.sales_score - a.sales_score ||
      b.views_per_day - a.views_per_day
  );

  const heroCandidates = rows
    .filter((row) => row.action.code === 'HERO')
    .slice(0, clamp(Number(heroLimit) || 25, 1, 50));

  const fallbackHeroes =
    heroCandidates.length >= Math.min(10, heroLimit)
      ? heroCandidates
      : rows
          .slice(0, clamp(Number(heroLimit) || 25, 1, 50))
          .map((row) => ({
            ...row,
            action:
              row.action.code === 'HERO'
                ? row.action
                : {
                    ...row.action,
                    candidate: true
                  }
          }));

  const counts = rows.reduce(
    (acc, row) => {
      acc[row.action.code] =
        (acc[row.action.code] || 0) + 1;
      return acc;
    },
    {}
  );

  const totalViews = rows.reduce(
    (sum, row) => sum + row.views,
    0
  );
  const totalFavorites = rows.reduce(
    (sum, row) => sum + row.favorites,
    0
  );

  return {
    ok: true,
    read_only: true,
    etsy_modified: false,
    engine: 'vaelons-sales-engine-v1',
    target: {
      orders_per_day: 3,
      orders_per_month: 90,
      required_daily_visits: {
        at_1pct_conversion: 300,
        at_1_5pct_conversion: 200,
        at_2pct_conversion: 150
      }
    },
    coverage: {
      active_listings: rows.length,
      total_views: totalViews,
      total_favorites: totalFavorites,
      lifetime_favorite_rate_pct:
        totalViews > 0
          ? round2((totalFavorites / totalViews) * 100)
          : null,
      listings_with_views:
        rows.filter((row) => row.views > 0).length,
      listings_with_favorites:
        rows.filter((row) => row.favorites > 0).length,
      listings_with_image_data:
        rows.filter(
          (row) => row.listing_health.image_count > 0
        ).length
    },
    action_counts: counts,
    hero_count: fallbackHeroes.length,
    hero_candidates: fallbackHeroes,
    listings: rows,
    data_limits: {
      views_available: availability.views,
      image_counts_available: availability.images,
      favorites_available: availability.favorites,
      impressions_available: false,
      per_listing_orders_available: false,
      etsy_ads_spend_available: false,
      reason:
        'Current safe OAuth connection is intentionally unchanged. This version uses listing engagement and quality signals only.'
    }
  };
}
