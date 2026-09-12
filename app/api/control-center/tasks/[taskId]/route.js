import { NextResponse } from 'next/server';

import { generationPublic } from '../../../../../lib/control-center/content-generator.js';
import { getGeneration } from '../../../../../lib/control-center/store.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request, { params }) {
  try {
    const { taskId } = await params;
    const task = await getGeneration(String(taskId || ''));
    if (!task) {
      return NextResponse.json({ ok: false, error: 'Görev bulunamadı' }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      task: generationPublic(task),
      etsy_modified: task.etsy_modified === true
    }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error?.message || 'Görev okunamadı',
      etsy_modified: false
    }, { status: error?.status || 500 });
  }
}
