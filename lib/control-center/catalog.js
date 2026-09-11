import {
  etsyRequest,
  getListingImages,
  getShopId,
  getTokenStatus,
  getVerifiedShopIdentity
} from '../../src/etsy.js';
import { auditListing } from './audit.js';
import { asListingId } from './metadata.js';
import { getWritePolicy } from './write-policy.js';

function normalizeMoney(price) {
  if (!price) return null;
  if (typeof price === 'number') return { amount: price, currency: null };
  const divisor = Number(price.divisor || 100) || 100;
  const amount = Number(price.amount);
  if (!Number.isFinite(amount)) return null;
  return {
    amount: amount / divisor,
    currency: price.currency_code || null
  };
}

function sortedImages(images) {
  return Array.isArray(images)
    ? [...images].sort((a, b) => Number(a?.rank ?? 999) - Number(b?.rank ?? 999))
    : [];
}

function normalizeImage(image) {
  return {
    image_id: Number(image?.listing_image_id || image?.image_id) || null,
    rank: Number(image?.rank) || null,
    alt_text: String(image?.alt_text || ''),
    url_75x75: image?.url_75x75 || null,
    url_170x135: image?.url_170x135 || null,
    url_570xN: image?.url_570xN || null,
    url_fullxfull: image?.url_fullxfull || null,
    width: Number(image?.full_width) || null,
    height: Number(image?.full_height) || null
  };
}

function normalizeImages(listing) {
  const images = sortedImages(listing?.images);
  const hero = images[0] || null;
  return {
    image_count: images.length,
    hero_url: hero?.url_570xN || hero?.url_fullxfull || hero?.url_300x300 || null,
    hero_image_id: hero?.listing_image_id || hero?.image_id || null
  };
}

export async function fetchListingDetail(listingId) {
  const id = asListingId(listingId);
  const [identity, listing, imagePage] = await Promise.all([
    getVerifiedShopIdentity(),
    etsyRequest(`/listings/${id}`),
    getListingImages(id)
  ]);

  if (String(listing?.shop_id || '') !== String(identity.shop_id)) {
    const error = new Error('Listing doğrulanan VAELONS mağazasına ait değil');
    error.status = 404;
    throw error;
  }

  const images = sortedImages(imagePage.results);
  const normalized = normalizeListing({ ...listing, images });

  return {
    ...normalized,
    images: images.map(normalizeImage),
    shop_identity: identity,
    write_policy: getWritePolicy(),
    generated_at: new Date().toISOString()
  };
}

function normalizeListing(listing) {
  const imageData = normalizeImages(listing);
  const normalized = {
    listing_id: Number(listing?.listing_id),
    title: String(listing?.title || ''),
    description: String(listing?.description || ''),
    state: String(listing?.state || ''),
    tags: Array.isArray(listing?.tags) ? listing.tags : [],
    taxonomy_id: listing?.taxonomy_id || null,
    url: listing?.url || null,
    price: normalizeMoney(listing?.price),
    quantity: Number.isFinite(Number(listing?.quantity)) ? Number(listing.quantity) : null,
    created_timestamp: listing?.creation_timestamp || listing?.created_timestamp || null,
    updated_timestamp: listing?.last_modified_timestamp || listing?.updated_timestamp || null,
    ...imageData
  };
  return {
    ...normalized,
    audit: auditListing(normalized)
  };
}

export async function fetchCatalog(state = 'active') {
  const shopId = await getShopId();
  const results = [];
  const limit = 100;
  let offset = 0;
  let total = null;

  for (let page = 0; page < 12; page += 1) {
    const data = await etsyRequest(`/shops/${shopId}/listings`, {
      params: {
        limit,
        offset,
        state,
        includes: 'Images'
      }
    });

    const pageResults = Array.isArray(data?.results) ? data.results : [];
    if (total === null) total = Number(data?.count ?? pageResults.length);
    results.push(...pageResults.map(normalizeListing));

    offset += pageResults.length;
    if (!pageResults.length || pageResults.length < limit || offset >= total) break;
  }

  return {
    shop_id: Number(shopId),
    state,
    total_count: total ?? results.length,
    loaded_count: results.length,
    listings: results
  };
}

export async function getDashboardSnapshot() {
  const startedAt = Date.now();
  const [token, identity] = await Promise.all([
    getTokenStatus(),
    getVerifiedShopIdentity()
  ]);
  const catalog = await fetchCatalog('active');
  const writePolicy = getWritePolicy();

  const decisions = catalog.listings.reduce((acc, listing) => {
    const key = listing.audit.decision;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const summary = catalog.listings.reduce((acc, listing) => {
    if (listing.audit.requires_visual_review) acc.visual_review_count += 1;
    if (listing.audit.claim_review_required) acc.claim_review_count += 1;
    if (['REPAIR', 'BLOCKED'].includes(listing.audit.decision)) acc.repair_or_blocked_count += 1;
    return acc;
  }, { visual_review_count: 0, claim_review_count: 0, repair_or_blocked_count: 0 });

  return {
    ok: true,
    mode: writePolicy.mode,
    write_lock: writePolicy.write_locked,
    write_policy: writePolicy,
    etsy_connected: Boolean(token?.connected),
    shop_identity: identity,
    catalog,
    decisions,
    summary,
    duration_ms: Date.now() - startedAt,
    generated_at: new Date().toISOString()
  };
}
