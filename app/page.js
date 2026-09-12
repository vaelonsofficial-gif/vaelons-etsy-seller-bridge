import CatalogClient from './components/CatalogClient.js';
import BackgroundQueuePanel from './components/BackgroundQueuePanel.js';
import { getDashboardSnapshot } from '../lib/control-center/catalog.js';
import { selectNextAutomationTask } from '../lib/control-center/content-generator.js';
import { listGenerations } from '../lib/control-center/store.js';

export const dynamic = 'force-dynamic';

function StatCard({ label, value, sub }) {
  return (
    <div className="statCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  );
}

export default async function HomePage() {
  let snapshot = null;
  let error = null;
  let backgroundTask = null;
  let queueError = null;

  const [snapshotResult, queueResult] = await Promise.allSettled([
    getDashboardSnapshot(),
    listGenerations(100)
  ]);

  if (snapshotResult.status === 'fulfilled') snapshot = snapshotResult.value;
  else error = snapshotResult.reason instanceof Error
    ? snapshotResult.reason.message
    : String(snapshotResult.reason);

  if (queueResult.status === 'fulfilled') {
    const selectedTask = selectNextAutomationTask(queueResult.value);
    if (selectedTask) {
      backgroundTask = {
        id: selectedTask.id,
        listing_id: selectedTask.listing_id,
        task_scope: selectedTask.task_scope,
        command: selectedTask.command,
        before: {
          title: selectedTask.before?.title || '',
          tags: Array.isArray(selectedTask.before?.tags) ? selectedTask.before.tags : [],
          description: selectedTask.before?.description || ''
        }
      };
    }
  } else {
    queueError = queueResult.reason instanceof Error
      ? queueResult.reason.message
      : String(queueResult.reason);
  }

  return (
    <main className="pageShell">
      <header className="pageTopbar">
        <div>
          <p className="eyebrow">OPERATIONS / v0.7.1</p>
          <h1>Genel Bakış</h1>
        </div>
        <div className="modePill"><span className="statusDot" /> {snapshot?.mode || 'READ_ONLY'} · {snapshot?.write_lock !== false ? 'WRITE LOCKED' : 'WRITE READY'}</div>
      </header>

      <section className="hero introHero">
        <h2>Mağazayı tek ekrandan gör, ölç, düzelt.</h2>
        <p>Etsy kataloğunu canlı okur, metadata denetimi yapar ve görsel/performance incelemesine hazırlanacak iş kuyruğunu çıkarır.</p>
      </section>

      <BackgroundQueuePanel task={backgroundTask} queueError={queueError} />

      {error ? (
        <section className="errorPanel">
          <b>Control Center henüz Etsy verisini okuyamadı.</b>
          <p>{error}</p>
          <small>Write lock aktif kaldı; Etsy’de değişiklik yapılmadı.</small>
        </section>
      ) : (
        <>
          <section className="statsGrid">
            <StatCard label="Etsy bağlantısı" value={snapshot.etsy_connected ? 'HEALTHY' : 'OFFLINE'} sub="VAELONS shop identity checked" />
            <StatCard label="Aktif listing" value={snapshot.catalog.loaded_count} sub={`Etsy total: ${snapshot.catalog.total_count}`} />
            <StatCard label="Görsel inceleme" value={snapshot.summary.visual_review_count} sub="Hero kalitesi doğrulaması bekliyor" />
            <StatCard label="Claim kontrolü" value={snapshot.summary.claim_review_count} sub={`${snapshot.summary.repair_or_blocked_count} listing repair / blocked`} />
          </section>

          <section className="notice">
            <div>
              <b>HERO ve reklam kararları şimdilik kilitli.</b>
              <p>Metadata tek başına satış potansiyelini kanıtlamaz. Görsel kalite ile CTR, favori, sipariş, harcama ve marj verisi bağlanmadan hiçbir listing reklama uygun sayılmaz.</p>
            </div>
            <div className="syncInfo">Son canlı okuma<br /><strong>{new Date(snapshot.generated_at).toLocaleString('tr-TR')}</strong></div>
          </section>

          <div id="catalog">
            <CatalogClient listings={snapshot.catalog.listings} />
          </div>
        </>
      )}
    </main>
  );
}
