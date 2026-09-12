import { NextResponse } from 'next/server';

import { isAutomationClaimExpired } from '../../../../../lib/control-center/content-generator.js';
import { listGenerations } from '../../../../../lib/control-center/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const tasks = await listGenerations(100);
    const metadataTasks = tasks.filter((task) => task.task_scope !== 'CREATIVE_IMAGES');
    const queued = metadataTasks.filter((task) => task.status === 'QUEUED').length;
    const reclaimable = metadataTasks.filter((task) => (
      task.status === 'IN_PROGRESS' && isAutomationClaimExpired(task)
    )).length;

    return NextResponse.json({
      ok: true,
      worker: 'CHATGPT_SCHEDULED_TASK',
      interval_minutes: 60,
      queued,
      reclaimable,
      work_available: queued + reclaimable > 0,
      external_ai_cost_usd: 0,
      etsy_publish_allowed: false
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error?.message || 'Automation status failed',
      etsy_modified: false
    }, { status: error?.status || 500 });
  }
}
