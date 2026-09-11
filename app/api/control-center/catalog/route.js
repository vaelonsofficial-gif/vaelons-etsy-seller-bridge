import { NextResponse } from 'next/server';
import { getDashboardSnapshot } from '../../../../lib/control-center/catalog.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const snapshot = await getDashboardSnapshot();
    return NextResponse.json(snapshot, {
      headers: { 'cache-control': 'no-store' }
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      mode: 'READ_ONLY',
      write_lock: true,
      etsy_modified: false,
      error: error?.message || 'Catalog read failed'
    }, { status: error?.status || 500 });
  }
}
