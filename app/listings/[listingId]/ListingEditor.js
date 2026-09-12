'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useRef, useState } from 'react';
import { METADATA_LABELS, reviewStatusLabel } from '../../../lib/control-center/review.js';

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
      {state.code && <details className="recordDetails"><summary>Teknik ayrıntı</summary><small>{state.code}</small></details>}
      {state.generation_id && (
        <Link className="statusRecordLink" href={`/generations/${state.generation_id}`}>
          Görev kaydını aç →
        </Link>
      )}
    </div>
  );
}

function FieldDiff({ action }) {
  if (!action) return null;

  return (
    <section className="reviewDiff" id="approval-preview" aria-label="Eski ve yeni içerik">
      <div className="sectionHeading compact">
        <div>
          <p className="eyebrow">ESKİ VE YENİ</p>
          <h2>Hazırlanan değişiklikler</h2>
        </div>
        <span className={`statusBadge status-${action.status}`}>{reviewStatusLabel(action.status)}</span>
      </div>
      <div className="diffFields">
        {action.changed_fields.map((field) => (
          <div className="reviewDiffField" key={field}>
            <h3>{METADATA_LABELS[field] || field}</h3>
            <div className="reviewDiffColumns">
              <div className="reviewBefore">
                <span className="diffColumnLabel">Şu an Etsy’de</span>
                <p>{field === 'tags' ? action.before[field].join(', ') : action.before[field]}</p>
              </div>
              <div className="reviewAfter">
                <span className="diffColumnLabel">Hazırlanan yeni metin</span>
                <p>{field === 'tags' ? action.proposed[field].join(', ') : action.proposed[field]}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
      <details className="recordDetails"><summary>İşlem ayrıntıları</summary><p>İşlem: {action.id}</p><p>Durum: {action.status}</p></details>
    </section>
  );
}

function ValidationDetails({ validation }) {
  if (!validation) return null;
  const issues = [...(validation.errors || []), ...(validation.warnings || [])];
  if (issues.length === 0) return null;

  return (
    <details className="validationDetails">
      <summary>Doğrulama ayrıntıları</summary>
      <ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
    </details>
  );
}

function GenerationSummary({ generation }) {
  if (!generation) return null;
  const queued = generation.status === 'QUEUED';
  const working = generation.status === 'IN_PROGRESS';
  const pending = queued || working;
  const blocked = generation.status === 'BLOCKED';

  return (
    <section className="generationSummary">
      <div className="generationSummaryTop">
        <div>
          <p className="eyebrow">{queued ? 'SEZAR WORK QUEUE' : working ? 'BACKGROUND WORKER' : blocked ? 'QA BLOCKED' : 'CONTENT READY'}</p>
          <h3>{queued
            ? 'Görev arka plan kuyruğunda'
            : working
              ? 'Sezar içeriği arka planda hazırlıyor'
              : generation.summary || (blocked ? 'İçerik kalite kontrolünde engellendi' : 'İçerik önerisi hazır')}</h3>
        </div>
        <Link href={`/generations/${generation.id}`}>Görev kaydı →</Link>
      </div>
      <p>{pending
        ? working
          ? 'Görev tek kullanımlık güvenli biletle alındı. Bu ekran sonucu otomatik kontrol ediyor; Etsy’ye hiçbir şey gönderilmiyor.'
          : 'Görev, Sezar’ın sonraki arka plan kontrolünde hazırlanacak. Hazır olunca ana ekranda görünecek.'
        : generation.expected_outcome}</p>
      <details className="recordDetails"><summary>Görev ayrıntıları</summary>
        {generation.safety_notes?.length > 0 && <ul>{generation.safety_notes.map((note) => <li key={note}>{note}</li>)}</ul>}
        <div className="generationMeta">
        <span>{generation.task_scope || generation.model}</span>
        <span>{generation.cached ? 'CACHE' : 'NEW'}</span>
        <span>Harici AI ücreti $0</span>
        <span>Etsy değişmedi</span>
        </div>
      </details>
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

export default function ListingEditor({ listing, writePolicy, contentPolicy, initialAction = null }) {
  const [command, setCommand] = useState(QUICK_COMMANDS[0].command);
  const [taskScope, setTaskScope] = useState('FULL_LISTING');
  const [title, setTitle] = useState(initialAction?.proposed?.title ?? listing.title);
  const [tags, setTags] = useState(
    initialAction?.proposed?.tags?.join('\n') ?? listing.tags.join('\n')
  );
  const [description, setDescription] = useState(
    initialAction?.proposed?.description ?? listing.description
  );
  const [activeAction, setActiveAction] = useState(initialAction);
  const [polledGeneration, setPolledGeneration] = useState(null);
  const [revisionOpen, setRevisionOpen] = useState(false);
  const [editingOpen, setEditingOpen] = useState(false);
  const commandInput = useRef(null);
  const [generationState, generationAction, generationPending] = useActionState(generateListingDraft, initialState);
  const [prepareState, prepareAction, preparePending] = useActionState(prepareListingChange, initialState);
  const [executeState, executeAction, executePending] = useActionState(executeListingChange, initialState);
  const [rollbackState, rollbackAction, rollbackPending] = useActionState(rollbackListingChange, initialState);

  const generation = polledGeneration?.id === generationState?.generation?.id
    ? polledGeneration
    : generationState?.generation || null;
  const taskPending = generationPending || ['QUEUED', 'IN_PROGRESS'].includes(generation?.status);

  useEffect(() => {
    if (revisionOpen) commandInput.current?.focus();
  }, [revisionOpen]);

  useEffect(() => {
    const taskId = generationState?.generation?.id;
    if (!taskId || !['QUEUED', 'IN_PROGRESS'].includes(generation?.status)) return undefined;

    let cancelled = false;
    let timer;
    const poll = async () => {
      try {
        const response = await fetch(`/api/control-center/tasks/${taskId}`, { cache: 'no-store' });
        const payload = await response.json();
        if (!cancelled && response.ok && payload.task) {
          setPolledGeneration(payload.task);
          if (payload.task.action) setActiveAction(payload.task.action);
          if (payload.task.proposal) {
            setTitle(payload.task.proposal.title);
            setTags(payload.task.proposal.tags.join('\n'));
            setDescription(payload.task.proposal.description);
          }
        }
      } catch {
        // A later poll retries transient network failures.
      }
      if (!cancelled) timer = window.setTimeout(poll, 30_000);
    };

    timer = window.setTimeout(poll, 5_000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [generation?.status, generationState?.generation?.id]);

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
    !taskPending && !preparePending && !revisionOpen &&
    writePolicy.can_execute &&
    writePolicy.allowed_listing_id === String(listing.listing_id) &&
    activeAction?.status === 'VALIDATED' &&
    activeAction?.qa?.passed === true &&
    draftMatchesEditor
  );

  return (
    <section className={`editorPanel commandCenterPanel ownerWorkspace${activeAction ? ' hasReview' : ''}`}>
      <div className="sectionHeading">
        <div>
          <p className="eyebrow">ÜRÜN #{listing.listing_id}</p>
          <h2>{activeAction ? 'İncele ve karar ver' : 'Bu ürün için içerik hazırla'}</h2>
          <p className="sectionIntro">{activeAction
            ? 'Eski ve yeni metinler aşağıda. Karar düğmeleri ekranın altında sabit durur.'
            : 'İstediğin değişikliği yaz. Hazır taslak ana ekranda incelemene sunulur.'}</p>
        </div>
        {activeAction && <a className="secondaryButton" href="#approval-preview">Değişikliklere git</a>}
      </div>

      <FieldDiff action={executeState?.action || activeAction} />

      <details className="disclosure requestDisclosure" open={!activeAction || revisionOpen} onToggle={(event) => setRevisionOpen(event.currentTarget.open)}>
        <summary>{activeAction ? 'Sezar’dan düzeltme iste' : 'Sezar’a görev ver'}</summary>
      <form action={generationAction} className="commandForm">
        <input type="hidden" name="listing_id" value={listing.listing_id} />
        <input type="hidden" name="revision_action_id" value={activeAction?.id || ''} />
        <label htmlFor={`scope-${listing.listing_id}`}>Ne hazırlansın?</label>
        <select
          id={`scope-${listing.listing_id}`}
          name="task_scope"
          value={taskScope}
          onChange={(event) => setTaskScope(event.target.value)}
        >
          <option value="FULL_LISTING">Başlık, etiketler ve açıklama</option>
          {!activeAction && <option value="CREATIVE_IMAGES">Görseller (ayrı inceleme)</option>}
        </select>
        <label htmlFor={`command-${listing.listing_id}`}>{activeAction ? 'Neyi değiştirmemi istersin?' : 'Ne yapılmasını istersin?'}</label>
        <textarea
          ref={commandInput}
          id={`command-${listing.listing_id}`}
          name="command"
          rows="5"
          maxLength={activeAction ? 800 : contentPolicy.max_command_characters}
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          placeholder={activeAction ? 'Örn. Başlığı kısalt, açıklamanın girişini daha sade yaz.' : 'Örn. Başlığı ve açıklamayı daha anlaşılır yap.'}
        />
        <div className="quickCommands" aria-label="Hazır komutlar">
          {QUICK_COMMANDS.map((item) => (
            <button type="button" key={item.label} onClick={() => setCommand(item.command)}>
              {item.label}
            </button>
          ))}
        </div>
        <div className="commandSubmitRow">
          <small>Hazırlık arka planda yapılır. Etsy’ye uygulanmaz.</small>
          <button className="primaryButton prepareContentButton" type="submit" disabled={taskPending || !contentPolicy.ready || command.trim().length < 8}>
            {taskPending ? 'Hazırlık bekleniyor…' : activeAction ? 'Düzeltme isteğini gönder' : 'Arka planda hazırla'}
          </button>
        </div>
      </form>
      </details>

      {!contentPolicy.ready && (
        <div className="formStatus error" role="status">
          <strong>Sezar iş kuyruğu kapalı</strong>
          <p>Ücretsiz görev kuyruğu tekrar etkinleştirildiğinde bu panelden görev verilebilecek.</p>
          <small>{contentPolicy.blockers.join(' · ')}</small>
        </div>
      )}
      <StatusMessage state={generationState} />
      <GenerationSummary generation={generation} />
      <ValidationDetails validation={generationState?.validation} />

      <details className="contentWorkspace disclosure" open={editingOpen} onToggle={(event) => setEditingOpen(event.currentTarget.open)}>
        <summary>Metinleri kendim düzenleyeceğim</summary>
        <div className="sectionHeading compact">
          <div>
            <p className="eyebrow">CONTENT WORKSPACE</p>
            <h3>{['QUEUED', 'IN_PROGRESS'].includes(generation?.status) ? 'Mevcut içerik · arka plan hazırlığı sürüyor' : 'Hazırlanan içerik'}</h3>
          </div>
          {generation && <span className={['QUEUED', 'IN_PROGRESS'].includes(generation.status) ? 'dirtyBadge' : 'cleanBadge'}>
            {generation.status === 'QUEUED' ? 'Kuyrukta' : generation.status === 'IN_PROGRESS' ? 'Hazırlanıyor' : 'Düzenlenebilir'}
          </span>}
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
      </details>

      <StatusMessage state={prepareState} />
      <ValidationDetails validation={prepareState?.validation} />

      {activeAction && <section className="publishGate approvalDock" aria-label="Onay ve yayın işlemleri">
        <div>
          <strong>{executeState?.ok ? 'Yayın tamamlandı' : taskPending ? 'Yeni hazırlık bekleniyor' : writePolicy.write_locked ? 'Etsy yayını şu anda kapalı' : 'Kararın hazır mı?'}</strong>
          <p id="approval-explanation">{executeState?.ok
            ? 'Değişiklik Etsy’ye uygulandı ve Etsy’den yeniden okunarak doğrulandı.'
            : taskPending
              ? 'Yeni taslak hazırlanırken önceki taslak bu ekrandan yayınlanamaz.'
            : revisionOpen
              ? 'Düzeltme isteğini gönder veya formu kapatıp taslağı incelemeye dön.'
            : canExecuteThisListing
              ? 'Onayın, yukarıda gösterilen değişiklikleri Etsy’ye uygular.'
              : activeAction && !draftMatchesEditor
                ? 'İçerik taslağından sonra düzenleme yaptınız. Yayından önce düzenlemeleri yeniden doğrulayın.'
                : writePolicy.write_locked
                  ? 'Taslağı inceleyebilir veya düzeltme isteyebilirsin. Yayın yetkisi henüz açılmadı.'
                  : 'Bu taslak için yayın yetkisi veya doğrulama eksik. İşlem ayrıntılarını kontrol et.'}</p>
        </div>

        <div className="approvalDockActions">
          <button className="secondaryButton" type="button" disabled={executePending || taskPending || executeState?.ok === true} onClick={() => {
            if (!revisionOpen) setCommand('');
            setTaskScope('FULL_LISTING');
            setRevisionOpen(true);
            commandInput.current?.focus();
          }}>Düzeltme iste</button>
        <form action={executeAction} className="oneClickApproval">
          <input type="hidden" name="action_id" value={activeAction?.id || ''} />
          <input type="hidden" name="approval" value={`YAYINLA ${listing.listing_id}`} />
          <button className="dangerButton" aria-describedby="approval-explanation" type="submit" disabled={!canExecuteThisListing || executePending}>
            {executePending ? 'Etsy’ye uygulanıyor…' : executeState?.ok ? 'Yayın doğrulandı' : 'Onayla ve Etsy’de yayınla'}
          </button>
        </form>
        </div>
        <StatusMessage state={executeState} />
      </section>}

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
