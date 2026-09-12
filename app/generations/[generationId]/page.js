import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  getGeneration,
  getGenerationEvents
} from '../../../lib/control-center/store.js';
import { classifyGenerationError } from '../../../lib/control-center/content-generator.js';
import TaskEditor from './TaskEditor.js';

export const dynamic = 'force-dynamic';

function metadataBlock(label, value) {
  return (
    <div className="generationRecordBlock">
      <span>{label}</span>
      <pre>{Array.isArray(value) ? value.join('\n') : value || '—'}</pre>
    </div>
  );
}

export default async function GenerationPage({ params }) {
  const { generationId } = await params;
  let generation;
  let events = [];

  try {
    [generation, events] = await Promise.all([
      getGeneration(generationId),
      getGenerationEvents(generationId)
    ]);
  } catch (error) {
    if (error?.status === 404) notFound();
    throw error;
  }

  if (!generation) notFound();
  const safeError = generation.error ? classifyGenerationError(generation.error) : null;

  return (
    <main className="pageShell">
      <header className="pageTopbar detailTopbar">
        <div>
          <Link className="backLink" href={`/listings/${generation.listing_id}`}>← Listing paneline dön</Link>
          <p className="eyebrow">TASK AUDIT</p>
          <h1>Listing iyileştirme görevi</h1>
        </div>
        <span className={`statusBadge status-${generation.status}`}>{generation.status}</span>
      </header>

      <section className="generationRecordGrid">
        <section className="panel generationRecordPanel">
          <div className="sectionHeading compact">
            <div>
              <p className="eyebrow">REQUEST</p>
              <h2>Komut ve kimlik</h2>
            </div>
            <Link href={`/listings/${generation.listing_id}`}>Listing #{generation.listing_id}</Link>
          </div>
          <dl className="recordFacts">
            <div><dt>Görev ID</dt><dd>{generation.id}</dd></div>
            <div><dt>Çalışma biçimi</dt><dd>{generation.engine || generation.response_model || generation.model}</dd></div>
            <div><dt>Kapsam</dt><dd>{generation.task_scope || 'LEGACY_AI_TASK'}</dd></div>
            <div><dt>Oluşturma</dt><dd>{new Date(generation.created_at).toLocaleString('tr-TR')}</dd></div>
            <div><dt>Etsy değişikliği</dt><dd>{generation.etsy_modified ? 'EVET' : 'HAYIR'}</dd></div>
          </dl>
          {metadataBlock('Sahip komutu', generation.command)}
          {generation.summary && metadataBlock('Değişiklik özeti', generation.summary)}
          {generation.expected_outcome && metadataBlock('Beklenen etki', generation.expected_outcome)}
          {generation.safety_notes?.length > 0 && metadataBlock('Güvenlik notları', generation.safety_notes)}
          {safeError && (
            <div className="errorPanel generationError">
              <b>{safeError.code}</b>
              <p>{safeError.message}</p>
              {safeError.code === 'LEGACY_GATEWAY_REMOVED' && (
                <small>Yeni görevler ücretli Gateway kullanmadan Sezar kuyruğuna kaydolur.</small>
              )}
            </div>
          )}
        </section>

        <section className="panel generationRecordPanel">
          <div className="sectionHeading compact">
            <div>
              <p className="eyebrow">PERSISTED OUTPUT</p>
              <h2>Hazırlanan içerik</h2>
            </div>
            {generation.action_id ? (
              <Link href={`/listings/${generation.listing_id}?action=${generation.action_id}`}>Kesin farkı aç →</Link>
            ) : (
              <span className="cleanBadge">Kayıtlı</span>
            )}
          </div>
          {generation.proposal ? (
            <>
              {metadataBlock('Başlık', generation.proposal.title)}
              {metadataBlock('13 etiket', generation.proposal.tags)}
              {metadataBlock('Açıklama', generation.proposal.description)}
            </>
          ) : (
            <div className="recordEmpty">
              <strong>{generation.status === 'QUEUED' ? 'Sezar hazırlığı bekleniyor' : 'İçerik oluşturulmadı'}</strong>
              <p>{generation.status === 'QUEUED'
                ? 'Görev ücretsiz kuyruğa kaydedildi. Hazırlık tamamlanana kadar Etsy’de hiçbir alan değiştirilmez.'
                : 'Bu görevde yayın taslağı oluşmadı. Etsy’de hiçbir alan değiştirilmedi.'}</p>
            </div>
          )}
        </section>
      </section>

      {['QUEUED', 'BLOCKED'].includes(generation.status) && generation.task_scope !== 'CREATIVE_IMAGES' && (
        <TaskEditor task={generation} />
      )}

      {generation.status === 'QUEUED' && generation.task_scope === 'CREATIVE_IMAGES' && (
        <section className="panel taskEditorPanel">
          <div className="sectionHeading">
            <div>
              <p className="eyebrow">SEZAR CREATIVE WORKSPACE</p>
              <h2>Görsel hazırlama kuyruğu</h2>
            </div>
            <span className="cleanBadge">Harici AI ücreti $0</span>
          </div>
          <div className="safetyCallout">
            <strong>Artwork kilidi korunacak.</strong>
            <p>Sezar görseli ChatGPT çalışma alanında hazırlayıp önce onaya sunacak. Onay verilmeden Etsy görselleri yüklenmez, silinmez veya sıralanmaz.</p>
          </div>
        </section>
      )}

      <section className="panel generationRecordPanel eventPanel">
        <div className="sectionHeading compact">
          <div>
            <p className="eyebrow">AUDIT TRAIL</p>
            <h2>Olay günlüğü</h2>
          </div>
          <span className="modePill">{events.length} EVENT</span>
        </div>
        <div className="eventList">
          {events.map((event, index) => (
            <div key={`${event.recorded_at}-${index}`}>
              <strong>{event.type}</strong>
              <span>{event.status}</span>
              <time>{new Date(event.recorded_at).toLocaleString('tr-TR')}</time>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
