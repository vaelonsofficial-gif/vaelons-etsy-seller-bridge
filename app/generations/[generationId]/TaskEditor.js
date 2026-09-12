'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import { completeQueuedTask } from './actions.js';

const initialState = { ok: null, message: '', action: null, etsy_modified: false };

export default function TaskEditor({ task }) {
  const [state, action, pending] = useActionState(completeQueuedTask, initialState);
  const tags = Array.isArray(task.before?.tags) ? task.before.tags.join('\n') : '';

  return (
    <section className="panel taskEditorPanel">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow">SEZAR WORKSPACE</p>
          <h2>Ücretsiz içerik hazırlama alanı</h2>
        </div>
        <span className="cleanBadge">Harici AI ücreti $0</span>
      </div>

      <div className="safetyCallout">
        <strong>Bu ekran Etsy’ye doğrudan yazmaz.</strong>
        <p>Sezar’ın hazırladığı başlık, 13 etiket ve açıklama burada doğrulanır. Başarılı sonuç yalnızca sahibin onay kuyruğuna geçer.</p>
      </div>

      <form action={action} className="editorForm taskEditorForm">
        <input type="hidden" name="generation_id" value={task.id} />

        <label>
          <span>İş özeti</span>
          <input name="summary" maxLength="500" placeholder="Örn. Arama niyeti ve satın alma güveni güçlendirildi." />
        </label>

        <label>
          <span>Başlık</span>
          <textarea name="title" rows="3" defaultValue={task.before?.title || ''} required />
        </label>

        <label>
          <span>Etiketler <small>tam 13 adet · her satıra bir etiket</small></span>
          <textarea name="tags" rows="8" defaultValue={tags} required />
        </label>

        <label>
          <span>Açıklama</span>
          <textarea name="description" rows="18" defaultValue={task.before?.description || ''} required />
        </label>

        <button className="primaryButton" type="submit" disabled={pending}>
          {pending ? 'İçerik doğrulanıyor…' : 'Hazırlanan içeriği doğrula'}
        </button>
      </form>

      {state.message && (
        <div className={state.ok ? 'formStatus success' : 'formStatus error'} role="status">
          <strong>{state.ok ? 'Hazır' : 'İşlem engellendi'}</strong>
          <p>{state.message}</p>
          {state.code && <small>{state.code}</small>}
          {state.action && (
            <Link className="statusRecordLink" href={`/listings/${state.listing_id}?action=${state.action.id}`}>
              Kesin farkı incele ve onayla →
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
