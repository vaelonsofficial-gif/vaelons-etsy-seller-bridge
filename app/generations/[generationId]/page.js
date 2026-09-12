import Link from 'next/link';
import { notFound } from 'next/navigation';

import {
  getGeneration,
  getGenerationEvents
} from '../../../lib/control-center/store.js';

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

  return (
    <main className="pageShell">
      <header className="pageTopbar detailTopbar">
        <div>
          <Link className="backLink" href={`/listings/${generation.listing_id}`}>← Listing paneline dön</Link>
          <p className="eyebrow">GENERATION AUDIT</p>
          <h1>İçerik üretim kaydı</h1>
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
            <div><dt>Generation ID</dt><dd>{generation.id}</dd></div>
            <div><dt>Model</dt><dd>{generation.response_model || generation.model}</dd></div>
            <div><dt>Oluşturma</dt><dd>{new Date(generation.created_at).toLocaleString('tr-TR')}</dd></div>
            <div><dt>Etsy değişikliği</dt><dd>{generation.etsy_modified ? 'EVET' : 'HAYIR'}</dd></div>
          </dl>
          {metadataBlock('Sahip komutu', generation.command)}
          {generation.summary && metadataBlock('Değişiklik özeti', generation.summary)}
          {generation.expected_outcome && metadataBlock('Beklenen etki', generation.expected_outcome)}
          {generation.safety_notes?.length > 0 && metadataBlock('Güvenlik notları', generation.safety_notes)}
        </section>

        <section className="panel generationRecordPanel">
          <div className="sectionHeading compact">
            <div>
              <p className="eyebrow">PERSISTED OUTPUT</p>
              <h2>Üretilen içerik</h2>
            </div>
            <span className="cleanBadge">Kayıtlı</span>
          </div>
          {metadataBlock('Başlık', generation.proposal?.title)}
          {metadataBlock('13 etiket', generation.proposal?.tags)}
          {metadataBlock('Açıklama', generation.proposal?.description)}
        </section>
      </section>

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
