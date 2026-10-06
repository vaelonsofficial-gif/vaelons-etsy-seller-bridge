import express from 'express';
import { etsyRequest, getShopId } from './etsy.js';

const router = express.Router();
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

const SCAN_CACHE_TTL_MS = Math.max(
  30_000,
  Number(process.env.ETSY_THUMBNAIL_SCAN_CACHE_MS || 300_000)
);

const scanCache = new Map();
const scanInFlight = new Map();

function listingId(v) {
  const id = String(v || '').trim();

  if (!/^\d+$/.test(id)) {
    const e = new Error('Invalid listingId');
    e.status = 400;
    throw e;
  }

  return id;
}

function rankOf(x) {
  return Number(x?.rank ?? x?.listing_image_rank ?? 9999);
}

function imageUrl(x) {
  return (
    x?.url_fullxfull ||
    x?.url_300x300 ||
    x?.url_570xN ||
    null
  );
}

function embeddedImages(listing) {
  if (Array.isArray(listing?.images)) {
    return listing.images;
  }

  if (Array.isArray(listing?.Images)) {
    return listing.Images;
  }

  return [];
}

function audit(listing, rows) {
  rows = [...rows].sort((a, b) => rankOf(a) - rankOf(b));

  const first = rows[0] || null;
  const count = rows.length;

  let score = 100;
  const issues = [];

  if (!first || !imageUrl(first)) {
    score -= 55;
    issues.push('rank_1_missing');
  }

  if (count < 5) {
    score -= 25;
    issues.push('too_few_images');
  } else if (count < 8) {
    score -= 12;
    issues.push('image_set_thin');
  }

  const w = Number(first?.full_width || 0);
  const h = Number(first?.full_height || 0);

  if (w && h && Math.min(w, h) < 2000) {
    score -= 15;
    issues.push('rank_1_resolution_under_2000');
  }

  score = clamp(score, 0, 100);

  return {
    listing_id: String(listing?.listing_id || ''),
    title: listing?.title || '',
    image_count: count,
    thumbnail_score: score,
    status:
      score >= 90
        ? 'strong'
        : score >= 75
          ? 'review'
          : 'needs_change',
    issues,
    source_locked: Boolean(first && imageUrl(first)),
    source_artwork:
      first
        ? {
            listing_image_id: first.listing_image_id,
            rank: rankOf(first),
            url: imageUrl(first),
            width: first.full_width || null,
            height: first.full_height || null
          }
        : null
  };
}

async function fetchListingWithImages(id) {
  const listing =
    await etsyRequest(
      '/listings/' + id,
      {
        params: {
          includes: 'Images'
        }
      }
    );

  let rows =
    embeddedImages(listing);

  // A single-listing action may safely fall back once if Etsy omits includes.
  if (!rows.length) {
    const images =
      await etsyRequest(
        '/listings/' + id + '/images'
      );

    rows =
      Array.isArray(images?.results)
        ? images.results
        : [];
  }

  return {
    listing,
    rows
  };
}

router.get(
  '/listings/:listingId/source',
  async (req, res, next) => {
    try {
      const id =
        listingId(
          req.params.listingId
        );

      const {
        listing,
        rows
      } =
        await fetchListingWithImages(
          id
        );

      const a =
        audit(
          listing,
          rows
        );

      if (!a.source_locked) {
        return res
          .status(409)
          .json({
            error:
              'rank_1_artwork_unavailable',
            generation_allowed:
              false,
            etsy_modified:
              false
          });
      }

      res.json({
        ok: true,
        ...a,
        source_rule:
          'ETSY_LISTING_RANK_1',
        generation_allowed:
          true,
        etsy_modified:
          false
      });

    } catch (e) {
      next(e);
    }
  }
);

async function buildSafeScan(max) {
  const shop =
    await getShopId();

  let offset = 0;
  let listings = [];

  while (
    listings.length < max
  ) {
    const page =
      await etsyRequest(
        '/shops/' +
          shop +
          '/listings',
        {
          params: {
            state: 'active',
            limit: 100,
            offset,
            includes: 'Images'
          }
        }
      );

    const rows =
      Array.isArray(
        page?.results
      )
        ? page.results
        : [];

    listings.push(
      ...rows
    );

    if (rows.length < 100) {
      break;
    }

    offset +=
      rows.length;
  }

  listings =
    listings.slice(
      0,
      max
    );

  // IMPORTANT: no per-listing Etsy image loop here.
  // Bulk scan must stay O(pages), not O(listings).
  const results =
    listings.map(
      (listing) => {
        const rows =
          embeddedImages(
            listing
          );

        if (!rows.length) {
          return {
            listing_id:
              String(
                listing?.listing_id ||
                  ''
              ),
            title:
              listing?.title ||
              '',
            image_count:
              0,
            thumbnail_score:
              0,
            status:
              'review',
            issues: [
              'image_data_not_in_bulk_response'
            ],
            source_locked:
              false,
            source_artwork:
              null
          };
        }

        return audit(
          listing,
          rows
        );
      }
    );

  const needs =
    results.filter(
      (x) =>
        x.status ===
        'needs_change'
    ).length;

  const review =
    results.filter(
      (x) =>
        x.status ===
        'review'
    ).length;

  return {
    ok: true,
    total_count:
      results.length,
    needs_change_count:
      needs,
    review_count:
      review,
    strong_count:
      results.length -
      needs -
      review,
    results:
      results.sort(
        (a, b) =>
          a.thumbnail_score -
          b.thumbnail_score
      ),
    api_safe:
      true,
    per_listing_image_requests:
      0,
    read_only:
      true,
    etsy_modified:
      false
  };
}

router.post(
  '/scan',
  async (req, res, next) => {
    try {
      const max =
        clamp(
          Number(
            req.body
              ?.listingLimit ||
              500
          ),
          1,
          500
        );

      const key =
        String(max);

      const cached =
        scanCache.get(key);

      if (
        cached &&
        cached.expiresAt >
          Date.now()
      ) {
        return res.json({
          ...cached.data,
          cached:
            true
        });
      }

      const existing =
        scanInFlight.get(
          key
        );

      if (existing) {
        const data =
          await existing;

        return res.json({
          ...data,
          deduplicated:
            true
        });
      }

      const pending =
        buildSafeScan(max)
          .then((data) => {
            scanCache.set(
              key,
              {
                data,
                expiresAt:
                  Date.now() +
                  SCAN_CACHE_TTL_MS
              }
            );

            return data;
          })
          .finally(
            () =>
              scanInFlight.delete(
                key
              )
          );

      scanInFlight.set(
        key,
        pending
      );

      const data =
        await pending;

      res.json(data);

    } catch (e) {
      next(e);
    }
  }
);

router.post(
  '/jobs/prepare',
  async (req, res, next) => {
    try {
      const id =
        listingId(
          req.body?.listingId
        );

      const preset =
        String(
          req.body?.preset ||
            'floor_large'
        );

      if (
        ![
          'floor_large',
          'wall_large'
        ].includes(preset)
      ) {
        return res
          .status(400)
          .json({
            error:
              'invalid_thumbnail_preset',
            allowed_presets: [
              'floor_large',
              'wall_large'
            ],
            etsy_modified:
              false
          });
      }

      const {
        rows
      } =
        await fetchListingWithImages(
          id
        );

      const ordered =
        [...rows].sort(
          (a, b) =>
            rankOf(a) -
            rankOf(b)
        );

      const source =
        ordered[0];

      const url =
        imageUrl(source);

      if (
        !source ||
        !url
      ) {
        return res
          .status(409)
          .json({
            error:
              'rank_1_artwork_unavailable',
            generation_allowed:
              false,
            etsy_modified:
              false
          });
      }

      res.json({
        ok: true,
        preview_only:
          true,
        listing_id:
          id,
        preset,
        source_locked:
          true,
        source_rule:
          'ETSY_LISTING_RANK_1',
        source_artwork: {
          listing_image_id:
            source.listing_image_id,
          rank:
            rankOf(source),
          url
        },
        generation_contract: {
          output_count:
            1,
          preserve_artwork_exactly:
            true,
          allow_redraw:
            false,
          allow_recolor:
            false,
          allow_crop:
            false,
          allow_stretch:
            false,
          allowed_presets: [
            'floor_large',
            'wall_large'
          ],
          composition:
            'large_attention_grabbing_hero_mockup',
          minimum_short_side_px:
            2000
        },
        provider_connected:
          false,
        generation_allowed:
          false,
        next_required:
          'local_renderer',
        api_safe:
          true,
        etsy_modified:
          false
      });

    } catch (e) {
      next(e);
    }
  }
);

export default router;
