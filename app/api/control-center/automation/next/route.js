import { NextResponse } from 'next/server';

import { claimNextListingContentTask } from '../../../../../lib/control-center/content-generator.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const task = await claimNextListingContentTask();
    return NextResponse.json({
      ok: true,
      task,
      completion_path: task ? '/api/control-center/automation/complete' : null,
      instructions: task
        ? 'Prepare only the requested listing metadata. Return no prose; submit one base64url-encoded JSON payload to completion_path.'
        : null,
      etsy_modified: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error?.message || 'Automation claim failed',
      code: error?.code || 'AUTOMATION_CLAIM_FAILED',
      etsy_modified: false
    }, { status: error?.status || 500 });
  }
}
