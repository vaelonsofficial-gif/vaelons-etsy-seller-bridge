'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useState } from 'react';

import {
  executeListingChange,
  generateListingDraft,
  prepareListingChange,
  rollbackListingChange
} from './actions.js';

const initialState = { ok: null, message: '', action: null, etsy_modified: false };

const QUICK_COMMANDS = [
  {
    label: 'Tam dönüşüm iyileştirmesi',
    command: 'Başlığı, 13 etiketi ve açıklamayı satın alma niyetine göre iyileştir. Mevcut gerçek ürün bilgilerini koru, doğrulanmayan iddiaları kaldır ve premium ama doğal bir dil kullan.'
  },
  {
    label: 'SEO + buyer-friendly',
    command: 'Başlığı buyer-friendly ve daha net yap. Tam 13 güçlü Etsy etiketi hazırla. Açıklamadaki doğrulanmış bilgileri koruyarak arama niyeti ile okunabilirliği dengeli biçimde iyileştir.'
  },
  {
    label: 'Güven ve açıklık',
    command: 'Tıklama sonrası satın alma güvenini artır. Yalnızca mevcut gerçek bilgilere dayanarak açıklamayı daha taranabilir, açık ve premium hale getir; eksik teknik bilgileri uydurma.'
  }
];

function StatusMessage({ state }) {
  if (!state?.message) return null;
  return (
    <div className={state.ok ? 'formStatus success' : 'formStatus error'} role="status">
      <strong>{state.ok ? 'Hazır' : 'İşlem engellendi'}</strong>
      <p>{state.message}</p>
      {state.code && <small>{state.code}</small>}
      {state.generation_id && (
        <Link className="statusRecordLink" href={`/generations/${state.generation_id}`}>
          Üretim kaydını aç →
        </Link>
      )}
    </div>
  );
}

function FieldDiff({ action }) {
  if (!action) return null;

  return (
    <section className="diffPanel" id="approval-preview">
      <div className="sectionHeading compact">
        <div>
          <p className="eyebrow">APPROVAL PREVIEW</p>
          <h3>Yayınlanacak kesin değişiklik</h3>
        </div>
        <span className={`statusBadge status-${action.status}`}>{action.status}</span>
      </div>
      <div className="diffFields">
        {action.changed_fields.map((field) => (
          <div className="diffRow" key={field}>
            <strong>{field}</strong>
            <span>Şu an Etsy’de</span>
            <p>{field === 'tags' ? action.before[field].join(', ') : action.before[field]}</p>
            <span>Onay sonrası</span>
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

function GenerationSummary({ generation }) {
  if (!generation) return null;
  const cost = generation.estimated_cost?.amount;

  return (
    <section className="generationSummary">
      <div className="generationSummaryTop">
        <div>
          <p className="eyebrow">CONTENT READY</p>
          <h3>{generation.summary || 'İçerik önerisi hazır'}</h3>
        </div>
        <Link href={`/generations/${generation.id}`}>Üretim kaydı →</Link>
      </div>
      <p>{generation.expected_outcome}</p>
      {generation.safety_notes?.length > 0 && (
        <ul>{generation.safety_notes.map((note) => <li key={note}>{note}</li>)}</ul>
      )}
      <div className="generationMeta">
        <span>{generation.model}</span>
        <span>{generation.cached ? 'CACHE' : 'NEW'}</span>
        <span>{Number.isFinite(cost) ? `Tahmini $${cost.toFixed(4)}` : 'Maliyet bekleniyor'}</span>
        <span>Etsy değişmedi</span>
      </div>
    </section>
  );
}

function normalizedEditorTags(value) {
  return value
    .split(/\r?\n/)
    .map((tag) => tag.replace(/\s{2,}/g, ' ').trim())
    .filter((tag, index, all) => tag && all.findIndex(
      (candidate) => candidate.toLocaleLowerCase('en-US') === tag.toLocaleLowerCase('en-US')
    ) === index)
    .join('\n');
}

export default function ListingEditor({ listing, writePolicy, contentPolicy }) {
  const [command, setCommand] = useState(QUICK_COMMANDS[0].command);
  const [title, setTitle] = useState(listing.title);
  const [tags, setTags] = useState(listing.tags.join('\n'));
  const [description, setDescription] = useState(listing.description);
  const [activeAction, setActiveAction] = useState(null);
  const [generationState, generationAction, generationPending] = useActionState(generateListingDraft, initialState);
  const [prepareState, prepareAction, preparePending] = useActionState(prepareListingChange, initialState);
  const [executeState, executeAction, executePending] = useActionState(executeListingChange, initialState);
  const [rollbackState, rollbackAction, rollbackPending] = useActionState(rollbackListingChange, initialState);

  const generation = generationState?.generation || null;

  useEffect(() => {
    if (!generation?.proposal) return;
    setTitle(generation.proposal.title);
    setTags(generation.proposal.tags.join('\n'));
    setDescription(generation.proposal.description);
    setActiveAction(generation.action || null);
  }, [generation?.id]);

  useEffect(() => {
    if (prepareState?.action) setActiveAction(prepareState.action);
  }, [prepareState?.action?.id]);

  const changedFields = useMemo(() => {
    const fields = [];
    if (title.trim() !== listing.title) fields.push('title');
    if (tags.trim() !== listing.tags.join('\n')) fields.push('tags');
    if (description.trim() !== listing.description) fields.push('description');
    return fields;
  }, [description, listing.description, listing.tags, listing.title, tags, title]);

  const draftMatchesEditor = Boolean(
    activeAction &&
    activeAction.proposed.title === title.trim().replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ') &&
    activeAction.proposed.description === description.replace(/\r\n/g, '\n').trim() &&
    activeAction.proposed.tags.join('\n') === normalizedEditorTags(tags)
  );
  const canExecuteThisListing = Boolean(
    !executeState?.ok &&
    writePolicy.can_execute &&
    writePolicy.allowed_listing_id === String(listing.listing_id) &&
    activeAction?.status === 'VALIDATED' &&
    activeAction?.qa?.passed === true &&
    draftMatchesEditor
  );

  return (
    <section className="editorPanel commandCenterPanel">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow">VAELONS COMMAND CENTER</p>
          <h2>Komut ver, incele, onayla</h2>
        </div>
        <span className={changedFields.length ? 'dirtyBadge' : 'cleanBadge'}>
          {changedFields.length ? `${changedFields.length} alan hazır` : 'Canlı sürüm'}
        </span>
      </div>

      <ol className="commandSteps" aria-label="İşlem adımları">
        <li className="active"><span>1</span> Komut</li>
        <li className={generation ? 'active' : ''}><span>2</span> Hazırlık</li>
        <li className={activeAction?.status === 'VALIDATED' ? 'active' : ''}><span>3</span> Onay</li>
        <li className={executeState?.ok ? 'active' : ''}><span>4</span> Yayın</li>
      </ol>

      <div className="safetyCallout">
        <strong>Hazırlama ve yayınlama birbirinden ayrıdır.</strong>
        <p>Komut içerik taslağı üretir. Etsy ancak doğrulanmış farkları görüp “Onayla ve yayınla” düğmesine bastığınızda değişir.</p>
      </div>

      <form action={generationAction} className="commandForm">
        <input type="hidden" name="listing_id" value={listing.listing_id} />
        <label htmlFor={`command-${listing.listing_id}`}>Sezar’a görev ver</label>
        <textarea
          id={`command-${listing.listing_id}`}
          name="command"
          rows="5"
          maxLength={contentPolicy.max_command_characters}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder="Örn. Bu listingin başlığını, 13 etiketini ve açıklamasını satışa hazır hale getir."
        />
        <div className="quickCommands" aria-label="Hazır komutlar">
          {QUICK_COMMANDS.map((item) => (
            <button type="button" key={item.label} onClick={() => setCommand(item.command)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="commandSubmitRow">
          <small>{command.length}/{contentPolicy.max_command_characters} · Bu adım Etsy’yi değiştirmez</small>
          <button className="primaryButton prepareContentButton" type="submit" disabled={generationPending || !contentPolicy.ready || command.trim().length < 8}>
            {generationPending ? 'İçerik hazırlanıyor…' : 'İçeriği hazırla'}
          </button>
        </div>
      </form>

      {!contentPolicy.ready && (
        <div className="formStatus error" role="status">
          <strong>İçerik motoru bağlantı bekliyor</strong>
          <p>AI Gateway yetkilendirmesi hazır olduğunda aynı panelden içerik üretilebilecek.</p>
          <small>{contentPolicy.blockers.join(' · ')}</small>
        </div>
      )}
      <StatusMessage state={generationState} />
      <GenerationSummary generation={generation} />
      <ValidationDetails validation={generationState?.validation} />

      <section className="contentWorkspace">
        <div className="sectionHeading compact">
          <div>
            <p className="eyebrow">CONTENT WORKSPACE</p>
            <h3>Hazırlanan içerik</h3>
          </div>
          {generation && <span className="cleanBadge">Düzenlenebilir</span>}
        </div>

        <form action={prepareAction} className="editorForm">
          <input type="hidden" name="listing_id" value={listing.listing_id} />
          <input type="hidden" name="reason" value={generation ? `owner_edit_after_generation:${generation.id}` : 'control_center_listing_editor'} />

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

          <button className="secondaryButton" type="submit" disabled={preparePending || changedFields.length === 0}>
            {preparePending ? 'Doğrulanıyor…' : draftMatchesEditor ? 'Taslak doğrulandı' : 'Düzenlemeleri yeniden doğrula'}
          </button>
        </form>
      </section>

      <StatusMessage state={prepareState} />
      <ValidationDetails validation={prepareState?.validation} />
      <FieldDiff action={activeAction} />

      <section className="publishGate">
        <div>
          <p className="eyebrow">HUMAN APPROVAL GATE</p>
          <h3>Onay ve Etsy yayını</h3>
          <p>{executeState?.ok
            ? 'Değişiklik Etsy’ye uygulandı ve Etsy’den yeniden okunarak doğrulandı.'
            : canExecuteThisListing
              ? 'Taslak doğrulandı. Bu düğme yalnızca yukarıda gösterilen alanları Etsy’ye uygular ve sonucu tekrar kontrol eder.'
              : activeAction && !draftMatchesEditor
                ? 'İçerik taslağından sonra düzenleme yaptınız. Yayından önce düzenlemeleri yeniden doğrulayın.'
                : writePolicy.write_locked
                  ? 'Yayın güvenlik kilidi aktif. İçerik hazırlama çalışır; canlı yayın seçili test listingi yetkilendirilene kadar kapalıdır.'
                  : 'Yayın için doğrulanmış bir içerik taslağı hazırlayın.'}</p>
        </div>

        <form action={executeAction} className="oneClickApproval">
          <input type="hidden" name="action_id" value={activeAction?.id || ''} />
          <input type="hidden" name="approval" value={`YAYINLA ${listing.listing_id}`} />
          <button className="dangerButton" type="submit" disabled={!canExecuteThisListing || executePending}>
            {executePending ? 'Etsy’ye uygulanıyor…' : executeState?.ok ? 'Yayın doğrulandı' : 'Onayla ve Etsy’de yayınla'}
          </button>
          <small>Tek listing · yalnızca gösterilen farklar · yayın sonrası otomatik doğrulama</small>
        </form>
        <StatusMessage state={executeState} />
      </section>

      {executeState?.ok && executeState?.action && (
        <section className="rollbackGate">
          <h3>Güvenli geri alma</h3>
          <p>Control Center’ın kaydettiği önceki sürümü tek işlemle geri yükler ve Etsy sonucunu tekrar doğrular.</p>
          <form action={rollbackAction} className="oneClickApproval">
            <input type="hidden" name="action_id" value={executeState.action.id} />
            <input type="hidden" name="approval" value={`GERI AL ${listing.listing_id}`} />
            <button className="secondaryButton" type="submit" disabled={rollbackPending}>
              {rollbackPending ? 'Geri alınıyor…' : 'Doğrulanmış değişikliği geri al'}
            </button>
          </form>
          <StatusMessage state={rollbackState} />
        </section>
      )}
    </section>
  );
}
