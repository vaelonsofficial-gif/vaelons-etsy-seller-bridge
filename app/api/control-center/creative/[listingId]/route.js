import { NextResponse } from 'next/server';

import { fetchListingDetail } from '../../../../../lib/control-center/catalog.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  try {
    const { listingId } = await params;
    const listing = await fetchListingDetail(listingId);

    return NextResponse.json({
      ok: true,
      listing_id: listing.listing_id,
      creative_audit: listing.creative_audit,
      etsy_modified: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error?.message || 'Creative audit failed',
      etsy_modified: false
    }, {
      status: error?.status || 500,
      headers: { 'cache-control': 'no-store' }
    });
  }
}
