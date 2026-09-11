import { NextResponse } from 'next/server';
import { getShopId, getTokenStatus } from '../../../../src/etsy.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [shopId, token] = await Promise.all([getShopId(), getTokenStatus()]);
    return NextResponse.json({
      ok: true,
      service: 'vaelons-control-center',
      version: '0.1.0',
      mode: 'READ_ONLY',
      write_lock: true,
      etsy_connected: Boolean(token?.connected),
      shop_identity_verified: true,
      shop_id: Number(shopId),
      etsy_modified: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      service: 'vaelons-control-center',
      version: '0.1.0',
      mode: 'READ_ONLY',
      write_lock: true,
      shop_identity_verified: false,
      etsy_modified: false,
      error: error?.message || 'Health check failed'
    }, { status: error?.status || 500 });
  }
}
