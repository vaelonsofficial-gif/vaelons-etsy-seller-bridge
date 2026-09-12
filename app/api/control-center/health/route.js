import { NextResponse } from 'next/server';
import { getSystemHealth } from '../../../../lib/control-center/health.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const health = await getSystemHealth();
    return NextResponse.json({
      service: 'vaelons-control-center',
      ...health,
      etsy_modified: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      service: 'vaelons-control-center',
      version: '0.5.0',
      mode: 'READ_ONLY',
      write_lock: true,
      shop_identity_verified: false,
      etsy_modified: false,
      error: error?.message || 'Health check failed'
    }, { status: error?.status || 500 });
  }
}
