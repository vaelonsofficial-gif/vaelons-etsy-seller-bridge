import {
  etsyRequest,
  getShopId
} from './etsy.js';

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

function canonicalVariationValue(value) {
  let text = String(value ?? '')
    .replace(/&quot;|&#34;|&#x22;/gi, '"')
    .replace(/[“”″]/g, '"')
    .replace(/[×✕*]/g, 'x')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const orderedSize = (a, b, unit) => {
    const values = [
      Number(String(a).replace(',', '.')),
      Number(String(b).replace(',', '.'))
    ].sort((x, y) => x - y);

    return `${values[0]}x${values[1]}${unit}`;
  };

  const cm = text.match(
    /(\d+(?:[.,]\d+)?)\s*x\s*(\d+(?:[.,]\d+)?)\s*cm\b/i
  );
  if (cm) return orderedSize(cm[1], cm[2], 'cm');

  const inch = text.match(
    /(\d+(?:[.,]\d+)?)\s*"\s*x\s*(\d+(?:[.,]\d+)?)\s*"/i
  );
  if (inch) {
    const a = Math.round(Number(inch[1].replace(',', '.')) * 2.54);
    const b = Math.round(Number(inch[2].replace(',', '.')) * 2.54);
    return orderedSize(a, b, 'cm');
  }

  return text;
}

function variationKey(product) {
  return (product?.property_values || [])
    .flatMap((property) =>
      (property?.values || []).map(canonicalVariationValue)
    )
    .filter(Boolean)
    .sort()
    .join('::');
}

function variationLabel(product) {
  return (product?.property_values || [])
    .map((property) => {
      const name =
        property?.property_name ||
        property?.property_id ||
        'Varyasyon';

      return `${name}: ${(property?.values || []).join(', ')}`;
    })
    .join(' · ') || product?.sku || 'Standart';
}

function variationMatchesTarget(product, targetKey) {
  const wanted = String(targetKey || '')
    .split('::')
    .filter(Boolean);

  if (!wanted.length) return false;

  const actual = new Set(
    (product?.property_values || [])
      .flatMap((property) =>
        (property?.values || []).map(canonicalVariationValue)
      )
      .filter(Boolean)
  );

  return wanted.every((value) => actual.has(value));
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

function inventorySafetyView(
  inventory,
  {
    excludeTarget = false,
    targetKey = ''
  } = {}
) {
  return (inventory?.products || [])
    .filter(
      (product) =>
        !(
          excludeTarget &&
          variationMatchesTarget(product, targetKey)
        )
    )
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

function targetPrices(inventory, targetKey) {
  return (inventory?.products || [])
    .filter((product) =>
      variationMatchesTarget(product, targetKey)
    )
    .flatMap((product) =>
      (product?.offerings || []).map((offering) =>
        moneyToNumber(offering?.price)
      )
    )
    .filter((price) => Number.isFinite(price));
}

function buildInventoryPayload(
  inventory,
  {
    targetKey,
    updateTargetPrice = true,
    targetPrice
  }
) {
  return {
    products: (inventory?.products || []).map((product) => {
      const target =
        variationMatchesTarget(product, targetKey);

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

async function activeListings() {
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

    if (rows.length < 100) break;
  }

  return listings;
}

async function inventories(listingIds) {
  const rows = [];

  for (let index = 0; index < listingIds.length; index += 100) {
    const chunk = listingIds.slice(index, index + 100);
    if (!chunk.length) continue;

    const data = await etsyRequest(
      '/listings/batch/inventory',
      {
        params: {
          listing_ids: chunk
        }
      }
    );

    rows.push(
      ...(Array.isArray(data?.results) ? data.results : [])
    );
  }

  return rows;
}

async function listingInventory(listingId) {
  return etsyRequest(
    `/listings/${encodeURIComponent(String(listingId))}/inventory`
  );
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

export async function bridgeVariationTemplates() {
  const listings = await activeListings();

  if (!listings.length) {
    return {
      activeListingCount: 0,
      referenceListing: null,
      variations: []
    };
  }

  const reference = listings[0];
  const inventory = await listingInventory(reference.listing_id);
  const seen = new Set();
  const variations = [];

  for (const product of inventory?.products || []) {
    const key = variationKey(product);
    if (!key || seen.has(key)) continue;
    seen.add(key);

    variations.push({
      key,
      label: variationLabel(product),
      referenceProductId: product.product_id,
      currentPrice: moneyToNumber(product?.offerings?.[0]?.price)
    });
  }

  return {
    activeListingCount: listings.length,
    referenceListing: {
      listingId: Number(reference.listing_id),
      title: String(reference.title || '')
    },
    variations
  };
}

export async function bridgePreviewVariation(targetKey) {
  if (!targetKey) {
    const error = new Error('variationKey is required');
    error.status = 400;
    throw error;
  }

  const listings = await activeListings();
  const inventoryRows = await inventories(
    listings.map((listing) => listing.listing_id)
  );

  const inventoryMap = new Map(
    inventoryRows.map((row) => [
      String(row.listing_id),
      row.inventory
    ])
  );

  const matched = [];

  for (const listing of listings) {
    const inventory =
      inventoryMap.get(String(listing.listing_id));

    if (!inventory) continue;

    const productsMatched =
      (inventory?.products || []).filter((product) =>
        variationMatchesTarget(product, targetKey)
      ).length;

    if (!productsMatched) continue;

    matched.push({
      listingId: Number(listing.listing_id),
      title: String(listing.title || ''),
      productsMatched
    });
  }

  return {
    activeScanned: listings.length,
    matchedCount: matched.length,
    matched
  };
}

async function updateOne({
  listing,
  inventory,
  targetKey,
  targetPrice
}) {
  const listingId = Number(listing.listing_id);
  const beforePrices =
    targetPrices(inventory, targetKey);

  if (!beforePrices.length) {
    return {
      listingId,
      title: String(listing.title || ''),
      status: 'SKIPPED_NO_MATCH',
      verified: false
    };
  }

  const updatePayload = buildInventoryPayload(
    inventory,
    {
      targetKey,
      updateTargetPrice: true,
      targetPrice
    }
  );

  const rollbackPayload = buildInventoryPayload(
    inventory,
    {
      targetKey,
      updateTargetPrice: false,
      targetPrice
    }
  );

  await putInventory(listingId, updatePayload);

  const after = await listingInventory(listingId);
  const afterPrices = targetPrices(after, targetKey);

  const targetVerified =
    afterPrices.length > 0 &&
    afterPrices.every(
      (price) =>
        Math.abs(Number(price) - Number(targetPrice)) <
        0.001
    );

  const otherInventoryVerified =
    stableJson(
      inventorySafetyView(inventory, {
        excludeTarget: true,
        targetKey
      })
    ) ===
    stableJson(
      inventorySafetyView(after, {
        excludeTarget: true,
        targetKey
      })
    );

  if (!targetVerified || !otherInventoryVerified) {
    let rollbackVerified = false;

    try {
      await putInventory(listingId, rollbackPayload);
      const rollbackAfter =
        await listingInventory(listingId);

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
    newPrice: Number(targetPrice),
    verified: true,
    nonTargetInventoryVerified: true
  };
}

export async function bridgeApplyVariation({
  targetKey,
  targetPrice,
  listingIds
}) {
  const price = Number(targetPrice);

  if (!targetKey) {
    const error = new Error('variationKey is required');
    error.status = 400;
    throw error;
  }

  if (!Number.isFinite(price) || price <= 0) {
    const error = new Error('A valid targetPrice is required');
    error.status = 400;
    throw error;
  }

  const requestedIds = [
    ...new Set(
      (Array.isArray(listingIds) ? listingIds : [])
        .map((id) => String(id))
        .filter((id) => /^\d+$/.test(id))
    )
  ];

  if (!requestedIds.length || requestedIds.length > 25) {
    const error = new Error(
      'Each apply request must contain 1-25 listingIds'
    );
    error.status = 400;
    throw error;
  }

  const listings = await activeListings();
  const listingMap = new Map(
    listings.map((listing) => [
      String(listing.listing_id),
      listing
    ])
  );

  const selected = requestedIds
    .map((id) => listingMap.get(id))
    .filter(Boolean);

  if (selected.length !== requestedIds.length) {
    const error = new Error(
      'One or more listingIds are not active VAELONS listings'
    );
    error.status = 400;
    throw error;
  }

  const inventoryRows = await inventories(requestedIds);
  const inventoryMap = new Map(
    inventoryRows.map((row) => [
      String(row.listing_id),
      row.inventory
    ])
  );

  const results = [];

  for (const listing of selected) {
    const inventory =
      inventoryMap.get(String(listing.listing_id));

    if (!inventory) {
      results.push({
        listingId: Number(listing.listing_id),
        title: String(listing.title || ''),
        status: 'SKIPPED_NO_INVENTORY',
        verified: false
      });
      continue;
    }

    try {
      results.push(
        await updateOne({
          listing,
          inventory,
          targetKey,
          targetPrice: price
        })
      );
    } catch (error) {
      results.push({
        listingId: Number(listing.listing_id),
        title: String(listing.title || ''),
        status: 'ERROR',
        error: error.message,
        details: error.details || null,
        verified: false
      });
    }
  }

  return {
    requestedCount: requestedIds.length,
    changedCount: results.filter(
      (row) => row.status === 'UPDATED'
    ).length,
    verifiedCount: results.filter(
      (row) => row.verified === true
    ).length,
    errorCount: results.filter(
      (row) => row.status === 'ERROR'
    ).length,
    results
  };
}
