import crypto from 'node:crypto';

import {
  etsyRequest,
  getShopId
} from './etsy.js';

export const TARGET_PRICE = 38.99;
export const TARGET_VARIATION = 'Rolled Canvas 13x18 cm';

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[×*]/g, 'x')
    .replace(/\s+/g, ' ');
}

function compact(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, '');
}

function moneyToNumber(price) {
  if (price == null) return null;

  if (typeof price === 'number') {
    return Number(price);
  }

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

function allValues(product) {
  return (product?.property_values || [])
    .flatMap((property) => property?.values || [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean);
}

export function isRolledCanvas13x18(product) {
  const values = allValues(product);
  const normalized = values.map(normalize);
  const compacted = values.map(compact);

  const combined = compact(values.join(' '));

  const hasRolledCanvas =
    normalized.some((value) =>
      value.includes('rolled') && value.includes('canvas')
    ) ||
    combined.includes('rolledcanvas');

  const has13x18 =
    compacted.some((value) => value.includes('13x18')) ||
    combined.includes('13x18');

  return hasRolledCanvas && has13x18;
}

function cleanPropertyValue(property) {
  const result = {
    property_id: property.property_id,
    value_ids: Array.isArray(property.value_ids)
      ? property.value_ids
      : [],
    values: Array.isArray(property.values)
      ? property.values
      : []
  };

  if (property.property_name != null) {
    result.property_name = property.property_name;
  }

  if (property.scale_id != null) {
    result.scale_id = property.scale_id;
  }

  return result;
}

function cleanOffering(offering, price) {
  const result = {
    quantity: Number(offering.quantity ?? 0),
    is_enabled: Boolean(offering.is_enabled),
    price
  };

  if (offering.readiness_state_id != null) {
    result.readiness_state_id = Number(offering.readiness_state_id);
  }

  return result;
}

export function buildInventoryPayload(
  inventory,
  {
    updateTargetPrice = true,
    targetPrice = TARGET_PRICE
  } = {}
) {
  return {
    products: (inventory?.products || []).map((product) => {
      const target = isRolledCanvas13x18(product);

      return {
        sku: product?.sku || '',
        property_values: (product?.property_values || []).map(
          cleanPropertyValue
        ),
        offerings: (product?.offerings || []).map((offering) =>
          cleanOffering(
            offering,
            updateTargetPrice && target
              ? Number(targetPrice)
              : moneyToNumber(offering?.price)
          )
        )
      };
    }),

    price_on_property:
      Array.isArray(inventory?.price_on_property)
        ? inventory.price_on_property
        : [],

    quantity_on_property:
      Array.isArray(inventory?.quantity_on_property)
        ? inventory.quantity_on_property
        : [],

    sku_on_property:
      Array.isArray(inventory?.sku_on_property)
        ? inventory.sku_on_property
        : [],

    readiness_state_on_property:
      Array.isArray(inventory?.readiness_state_on_property)
        ? inventory.readiness_state_on_property
        : []
  };
}

function productKey(product) {
  return JSON.stringify({
    sku: product?.sku || '',
    properties: (product?.property_values || []).map((property) => ({
      property_id: property?.property_id ?? null,
      values: property?.values || [],
      value_ids: property?.value_ids || []
    }))
  });
}

function inventorySafetyView(inventory, { excludeTarget = false } = {}) {
  return (inventory?.products || [])
    .filter((product) => !(excludeTarget && isRolledCanvas13x18(product)))
    .map((product) => ({
      key: productKey(product),
      sku: product?.sku || '',
      properties: (product?.property_values || []).map((property) => ({
        property_id: property?.property_id ?? null,
        values: property?.values || [],
        value_ids: property?.value_ids || []
      })),
      offerings: (product?.offerings || []).map((offering) => ({
        price: moneyToNumber(offering?.price),
        quantity: Number(offering?.quantity ?? 0),
        is_enabled: Boolean(offering?.is_enabled),
        readiness_state_id:
          offering?.readiness_state_id == null
            ? null
            : Number(offering.readiness_state_id)
      }))
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

function stableJson(value) {
  return JSON.stringify(value);
}

function nonTargetInventoryUnchanged(before, after) {
  return (
    stableJson(inventorySafetyView(before, { excludeTarget: true })) ===
    stableJson(inventorySafetyView(after, { excludeTarget: true }))
  );
}

function targetPrices(inventory) {
  return (inventory?.products || [])
    .filter(isRolledCanvas13x18)
    .flatMap((product) =>
      (product?.offerings || []).map((offering) =>
        moneyToNumber(offering?.price)
      )
    )
    .filter((price) => Number.isFinite(price));
}

function targetValues(inventory) {
  return (inventory?.products || [])
    .filter(isRolledCanvas13x18)
    .map((product) => allValues(product));
}

export async function getActiveListings() {
  const shopId = await getShopId();
  const listings = [];

  for (let offset = 0; ; offset += 100) {
    const data = await etsyRequest(
      `/shops/${encodeURIComponent(shopId)}/listings`,
      {
        params: {
          state: 'active',
          limit: 100,
          offset
        }
      }
    );

    const rows = Array.isArray(data?.results)
      ? data.results
      : [];

    listings.push(...rows);

    if (rows.length < 100) {
      break;
    }
  }

  return listings;
}

export async function getInventories(listingIds) {
  const rows = [];

  for (let i = 0; i < listingIds.length; i += 100) {
    const chunk = listingIds.slice(i, i + 100);

    if (!chunk.length) continue;

    const data = await etsyRequest(
      '/listings/batch/inventory',
      {
        params: {
          listing_ids: chunk
        }
      }
    );

    rows.push(...(Array.isArray(data?.results) ? data.results : []));
  }

  return rows;
}

export async function getListingInventory(listingId) {
  return etsyRequest(
    `/listings/${encodeURIComponent(String(listingId))}/inventory`
  );
}

export async function scanRolledCanvas13x18() {
  const listings = await getActiveListings();

  if (!listings.length) {
    return {
      activeListingCount: 0,
      matchedListingCount: 0,
      results: []
    };
  }

  const inventories = await getInventories(
    listings.map((listing) => listing.listing_id)
  );

  const inventoryMap = new Map(
    inventories.map((row) => [
      String(row.listing_id),
      row.inventory
    ])
  );

  const results = [];

  for (const listing of listings) {
    const inventory = inventoryMap.get(String(listing.listing_id));
    if (!inventory) continue;

    const prices = targetPrices(inventory);
    if (!prices.length) continue;

    results.push({
      listingId: Number(listing.listing_id),
      title: String(listing.title || ''),
      url: listing.url || null,
      matchedValues: targetValues(inventory),
      currentPrices: prices,
      targetPrice: TARGET_PRICE,
      alreadyTarget:
        prices.every((price) => Math.abs(price - TARGET_PRICE) < 0.001)
    });
  }

  return {
    activeListingCount: listings.length,
    matchedListingCount: results.length,
    results
  };
}

async function putInventory(listingId, payload) {
  return etsyRequest(
    `/listings/${encodeURIComponent(String(listingId))}/inventory`,
    {
      method: 'PUT',
      params: {
        max_variations_supported: 3
      },
      json: payload
    }
  );
}

export async function updateOneListing(
  listing,
  inventory,
  targetPrice = TARGET_PRICE
) {
  const listingId = Number(listing.listing_id);
  const beforePrices = targetPrices(inventory);

  if (!beforePrices.length) {
    return {
      listingId,
      title: String(listing.title || ''),
      status: 'SKIPPED_NO_MATCH'
    };
  }

  if (
    beforePrices.every(
      (price) => Math.abs(price - targetPrice) < 0.001
    )
  ) {
    return {
      listingId,
      title: String(listing.title || ''),
      status: 'ALREADY_TARGET',
      oldPrices: beforePrices,
      newPrice: targetPrice,
      verified: true
    };
  }

  const updatePayload = buildInventoryPayload(inventory, {
    updateTargetPrice: true,
    targetPrice
  });

  const rollbackPayload = buildInventoryPayload(inventory, {
    updateTargetPrice: false
  });

  await putInventory(listingId, updatePayload);

  const after = await getListingInventory(listingId);
  const afterPrices = targetPrices(after);

  const targetVerified =
    afterPrices.length > 0 &&
    afterPrices.every(
      (price) => Math.abs(price - targetPrice) < 0.001
    );

  const otherInventoryVerified =
    nonTargetInventoryUnchanged(inventory, after);

  if (!targetVerified || !otherInventoryVerified) {
    let rollbackVerified = false;

    try {
      await putInventory(listingId, rollbackPayload);
      const rollbackAfter = await getListingInventory(listingId);

      rollbackVerified =
        stableJson(inventorySafetyView(inventory)) ===
        stableJson(inventorySafetyView(rollbackAfter));
    } catch {
      rollbackVerified = false;
    }

    const error = new Error(
      'Price update verification failed; rollback attempted'
    );
    error.status = 409;
    error.details = {
      listing_id: listingId,
      target_verified: targetVerified,
      other_inventory_verified: otherInventoryVerified,
      rollback_verified: rollbackVerified,
      old_prices: beforePrices,
      observed_prices: afterPrices
    };
    throw error;
  }

  return {
    listingId,
    title: String(listing.title || ''),
    status: 'UPDATED',
    oldPrices: beforePrices,
    newPrice: targetPrice,
    verified: true,
    nonTargetInventoryVerified: true
  };
}

export async function updateRolledCanvas13x18({
  offset = 0,
  limit = 20,
  targetPrice = TARGET_PRICE
} = {}) {
  const scan = await scanRolledCanvas13x18();

  const matchingIds = scan.results.map((row) => Number(row.listingId));
  const selectedIds = matchingIds.slice(offset, offset + limit);

  if (!selectedIds.length) {
    return {
      targetPrice,
      offset,
      limit,
      matchedListingCount: matchingIds.length,
      processedCount: 0,
      nextOffset: null,
      results: []
    };
  }

  const listings = await getActiveListings();
  const selectedListings = listings.filter((listing) =>
    selectedIds.includes(Number(listing.listing_id))
  );

  const inventoryRows = await getInventories(selectedIds);
  const inventoryMap = new Map(
    inventoryRows.map((row) => [
      String(row.listing_id),
      row.inventory
    ])
  );

  const results = [];

  for (const listing of selectedListings) {
    const inventory = inventoryMap.get(String(listing.listing_id));

    if (!inventory) {
      results.push({
        listingId: Number(listing.listing_id),
        title: String(listing.title || ''),
        status: 'SKIPPED_NO_INVENTORY'
      });
      continue;
    }

    try {
      results.push(
        await updateOneListing(listing, inventory, targetPrice)
      );
    } catch (error) {
      results.push({
        listingId: Number(listing.listing_id),
        title: String(listing.title || ''),
        status: 'ERROR',
        error: error.message,
        details: error.details || null
      });
    }
  }

  const nextOffset =
    offset + selectedIds.length < matchingIds.length
      ? offset + selectedIds.length
      : null;

  return {
    targetPrice,
    offset,
    limit,
    matchedListingCount: matchingIds.length,
    processedCount: results.length,
    nextOffset,
    results
  };
}

export function capabilityTokenMatches(rawToken, expectedHash) {
  const raw = Buffer.from(
    crypto.createHash('sha256').update(String(rawToken || '')).digest('hex')
  );
  const expected = Buffer.from(String(expectedHash || ''));

  return (
    raw.length === expected.length &&
    crypto.timingSafeEqual(raw, expected)
  );
}
