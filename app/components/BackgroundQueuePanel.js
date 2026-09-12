'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { completeBoundQueuedTask } from '../generations/[generationId]/actions.js';

const initialState = { ok: null, message: '', action: null, etsy_modified: false };

function sourceTags(task) {
  return Array.isArray(task?.before?.tags) ? task.before.tags.join('\n') : '';
}

export default function BackgroundQueuePanel({ task = null, queueError = null }) {
  const submitTask = completeBoundQueuedTask.bind(null, task?.id || '');
  const [state, action, pending] = useActionState(submitTask, initialState);

  return (
    <section className="panel backgroundQueuePanel" id="sezar-background-worker" aria-labelledby="background-worker-title">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow">SEZAR BACKGROUND DESK</p>
          <h2 id="background-worker-title">Arka plan hazırlama masası</h2>
        </div>
        <span className={task ? 'dirtyBadge' : 'cleanBadge'}>
          {task ? '1 GÖREV HAZIR' : 'KUYRUK BOŞ'}
        </span>
      </div>

      {queueError ? (
        <div className="formStatus error" role="status">
          <strong>Kuyruk okunamadı</strong>
          <p>{queueError}</p>
          <small>Etsy değişmedi; sonraki saatlik kontrolde yeniden denenecek.</small>
        </div>
      ) : !task ? (
        <div className="backgroundQueueEmpty">
          <strong>İşlenecek metadata görevi yok.</strong>
          <p>Bir listingden “Arka planda hazırla” komutu geldiğinde Sezar bu masada başlık, 13 etiket ve açıklamayı hazırlar.</p>
          <small>Görsel görevleri bu worker’dan ayrıdır · Etsy yayını kapalıdır</small>
        </div>
      ) : (
        <>
          <div className="backgroundTaskBrief">
            <div>
              <span>Görev</span>
              <strong>{task.id}</strong>
            </div>
            <div>
              <span>Listing</span>
              <strong>#{task.listing_id}</strong>
            </div>
            <div>
              <span>Kapsam</span>
              <strong>{task.task_scope}</strong>
            </div>
            <div>
              <span>Etsy</span>
              <strong>DEĞİŞMEZ</strong>
            </div>
          </div>

          <div className="backgroundOwnerCommand">
            <span>Sahip komutu</span>
            <p>{task.command}</p>
          </div>

          <form action={action} className="editorForm taskEditorForm backgroundWorkerForm">
            <label>
              <span>İş özeti</span>
              <input name="summary" maxLength="500" placeholder="Arama niyeti, açıklık ve satın alma güveni güçlendirildi." />
            </label>

            <label>
              <span>Başlık <small>İngilizce · en fazla 140 karakter</small></span>
              <textarea name="title" rows="3" defaultValue={task.before?.title || ''} required />
            </label>

            <label>
              <span>Etiketler <small>tam 13 benzersiz etiket · her satıra bir tane · en fazla 20 karakter</small></span>
              <textarea name="tags" rows="8" defaultValue={sourceTags(task)} required />
            </label>

            <label>
              <span>Açıklama <small>İngilizce · doğrulanmayan ürün iddiası yasak</small></span>
              <textarea name="description" rows="18" defaultValue={task.before?.description || ''} required />
            </label>

            <button className="primaryButton" type="submit" disabled={pending}>
              {pending ? 'Kalite kontrolü yapılıyor…' : 'Hazırla ve sahibin onayına bırak'}
            </button>
          </form>

          {state.message && (
            <div className={state.ok ? 'formStatus success' : 'formStatus error'} role="status">
              <strong>{state.ok ? 'Onaya hazır' : 'Kalite kontrolü engelledi'}</strong>
              <p>{state.message}</p>
              {state.code && <small>{state.code}</small>}
              {state.action && (
                <Link className="statusRecordLink" href={`/listings/${state.listing_id}?action=${state.action.id}`}>
                  Kesin farkı incele ve onayla →
                </Link>
              )}
            </div>
          )}
        </>
      )}

      <div className="backgroundWorkerRules" aria-label="Arka plan güvenlik kuralları">
        <span>Harici AI ücreti $0</span>
        <span>En fazla 1 görev / çalışma</span>
        <span>İnsan onayı zorunlu</span>
        <span>Otomatik Etsy yayını yok</span>
      </div>
    </section>
  );
}
