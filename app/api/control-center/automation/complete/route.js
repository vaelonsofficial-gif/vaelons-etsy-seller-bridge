import { NextResponse } from 'next/server';

import { completeClaimedListingContentTask } from '../../../../../lib/control-center/content-generator.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function decodePayload(value) {
  const encoded = String(value || '');
  if (!encoded || encoded.length > 10_000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    const error = new Error('Kodlanmış otomasyon sonucu geçersiz');
    error.status = 400;
    error.code = 'AUTOMATION_PAYLOAD_ENCODING_INVALID';
    throw error;
  }

  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    const error = new Error('Otomasyon sonucu çözümlenemedi');
    error.status = 400;
    error.code = 'AUTOMATION_PAYLOAD_DECODE_FAILED';
    throw error;
  }
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const completion = await completeClaimedListingContentTask({
      taskId: searchParams.get('task'),
      claimToken: searchParams.get('claim'),
      payload: decodePayload(searchParams.get('payload'))
    });

    return NextResponse.json({
      ok: completion.valid,
      cached: completion.cached === true,
      task_id: completion.task.id,
      listing_id: completion.task.listing_id,
      status: completion.task.status,
      action_id: completion.result.action?.id || null,
      validation: completion.result.validation,
      ready_for_owner_review: completion.valid,
      etsy_modified: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error?.message || 'Automation completion failed',
      code: error?.code || 'AUTOMATION_COMPLETION_FAILED',
      etsy_modified: false
    }, { status: error?.status || 500 });
  }
}
