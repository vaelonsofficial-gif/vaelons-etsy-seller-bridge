'use client';

import { useActionState, useMemo, useState } from 'react';

import {
  executeListingChange,
  prepareListingChange,
  rollbackListingChange
} from './actions.js';

const initialState = { ok: null, message: '', action: null, etsy_modified: false };

function StatusMessage({ state }) {
  if (!state?.message) return null;
  return (
    <div className={state.ok ? 'formStatus success' : 'formStatus error'} role="status">
      <strong>{state.ok ? 'Hazır' : 'İşlem engellendi'}</strong>
      <p>{state.message}</p>
      {state.code && <small>{state.code}</small>}
    </div>
  );
}

function FieldDiff({ action }) {
  if (!action) return null;

  return (
    <section className="diffPanel">
      <div className="sectionHeading compact">
        <div>
          <p className="eyebrow">CHANGESET</p>
          <h3>Önce / sonra özeti</h3>
        </div>
        <span className={`statusBadge status-${action.status}`}>{action.status}</span>
      </div>
      <div className="diffFields">
        {action.changed_fields.map((field) => (
          <div className="diffRow" key={field}>
            <strong>{field}</strong>
            <span>Mevcut sürüm</span>
            <p>{field === 'tags' ? action.before[field].join(', ') : action.before[field]}</p>
            <span>Önerilen sürüm</span>
            <p>{field === 'tags' ? action.proposed[field].join(', ') : action.proposed[field]}</p>
          </div>
        ))}
      </div>
      <div className="actionId">Action ID: {action.id}</div>
    </section>
  );
}

function ValidationDetails({ validation }) {
  if (!validation) return null;
  const issues = [...(validation.errors || []), ...(validation.warnings || [])];
  if (issues.length === 0) return null;

  return (
    <div className="validationDetails">
      <strong>Doğrulama ayrıntıları</strong>
      <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
    </div>
  );
}

export default function ListingEditor({ listing, writePolicy }) {
  const [title, setTitle] = useState(listing.title);
  const [tags, setTags] = useState(listing.tags.join('\n'));
  const [description, setDescription] = useState(listing.description);
  const [prepareState, prepareAction, preparePending] = useActionState(prepareListingChange, initialState);
  const [executeState, executeAction, executePending] = useActionState(executeListingChange, initialState);
  const [rollbackState, rollbackAction, rollbackPending] = useActionState(rollbackListingChange, initialState);

  const changedFields = useMemo(() => {
    const fields = [];
    if (title.trim() !== listing.title) fields.push('title');
    if (tags.trim() !== listing.tags.join('\n')) fields.push('tags');
    if (description.trim() !== listing.description) fields.push('description');
    return fields;
  }, [description, listing, tags, title]);

  const queuedAction = prepareState?.action || null;
  const draftMatchesEditor = Boolean(
    queuedAction &&
    queuedAction.proposed.title === title.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ') &&
    queuedAction.proposed.description === description.replace(/\r\n/g, '\n').trim() &&
    queuedAction.proposed.tags.join('\n') === tags
      .split(/\r?\n/)
      .map((tag) => tag.replace(/\s{2,}/g, ' ').trim())
      .filter((tag, index, all) => tag && all.findIndex((candidate) => candidate.toLocaleLowerCase('en-US') === tag.toLocaleLowerCase('en-US')) === index)
      .join('\n')
  );
  const canExecuteThisListing = Boolean(
    writePolicy.can_execute &&
    writePolicy.allowed_listing_id === String(listing.listing_id) &&
    queuedAction?.status === 'VALIDATED' &&
    draftMatchesEditor
  );

  return (
    <section className="editorPanel">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow">SAFE WRITE</p>
          <h2>Listing düzenleyici</h2>
        </div>
        <span className={changedFields.length ? 'dirtyBadge' : 'cleanBadge'}>
          {changedFields.length ? `${changedFields.length} alan değişti` : 'Değişiklik yok'}
        </span>
      </div>

      <div className="safetyCallout">
        <strong>Taslak oluşturmak Etsy’yi değiştirmez.</strong>
        <p>Önce mevcut sürüm yeniden okunur, kurallar doğrulanır ve geri alma kaydı hazırlanır.</p>
      </div>

      <form action={prepareAction} className="editorForm">
        <input type="hidden" name="listing_id" value={listing.listing_id} />
        <input type="hidden" name="reason" value="control_center_listing_editor" />

        <label>
          <span>Başlık <small>{title.length}/140</small></span>
          <textarea name="title" rows="3" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>

        <label>
          <span>Etiketler <small>{tags.split(/\r?\n/).filter((tag) => tag.trim()).length}/13 · her satıra bir etiket</small></span>
          <textarea name="tags" rows="8" value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>

        <label>
          <span>Açıklama <small>{description.length} karakter</small></span>
          <textarea name="description" rows="18" value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>

        <button className="primaryButton" type="submit" disabled={preparePending || changedFields.length === 0}>
          {preparePending ? 'Doğrulanıyor…' : 'Değişiklik taslağı oluştur'}
        </button>
      </form>

      <StatusMessage state={prepareState} />
      <ValidationDetails validation={prepareState?.validation} />
      <FieldDiff action={queuedAction} />

      <section className="publishGate">
        <div>
          <p className="eyebrow">EXECUTION GATE</p>
          <h3>Etsy’ye uygulama</h3>
          <p>{canExecuteThisListing
            ? 'Bu listing SAFE_WRITE için yetkilendirildi. Yayınlama sonrası otomatik doğrulama çalışacak.'
            : queuedAction && !draftMatchesEditor
              ? 'Editörde taslaktan sonra yeni değişiklik var. Uygulamadan önce yeni taslak oluşturulmalı.'
              : 'Global kilit aktif. Taslak hazırlanabilir fakat Etsy’ye gönderilemez.'}</p>
        </div>

        <form action={executeAction} className="approvalForm">
          <input type="hidden" name="action_id" value={queuedAction?.id || ''} />
          <label>
            <span>Onay metni</span>
            <input name="approval" placeholder={`YAYINLA ${listing.listing_id}`} disabled={!canExecuteThisListing} />
          </label>
          <button className="dangerButton" type="submit" disabled={!canExecuteThisListing || executePending}>
            {executePending ? 'Uygulanıyor…' : 'Etsy’ye uygula ve doğrula'}
          </button>
        </form>
        <StatusMessage state={executeState} />
      </section>

      {executeState?.ok && executeState?.action && (
        <section className="rollbackGate">
          <h3>Geri alma</h3>
          <p>Yalnızca Control Center’ın doğruladığı son değişikliği eski sürüme döndürür.</p>
          <form action={rollbackAction} className="approvalForm">
            <input type="hidden" name="action_id" value={executeState.action.id} />
            <input name="approval" placeholder={`GERI AL ${listing.listing_id}`} />
            <button className="secondaryButton" type="submit" disabled={rollbackPending}>
              {rollbackPending ? 'Geri alınıyor…' : 'Değişikliği geri al'}
            </button>
          </form>
          <StatusMessage state={rollbackState} />
        </section>
      )}
    </section>
  );
}
