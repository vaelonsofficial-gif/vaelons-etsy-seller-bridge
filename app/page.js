import CatalogClient from './components/CatalogClient.js';
import BackgroundQueuePanel from './components/BackgroundQueuePanel.js';
import PendingReviews from './components/PendingReviews.js';
import { getDashboardSnapshot } from '../lib/control-center/catalog.js';
import { selectNextAutomationTask } from '../lib/control-center/content-generator.js';
import { listActions, listGenerations } from '../lib/control-center/store.js';
import { verifiedTaskReceipts } from '../lib/control-center/review.js';

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

  const [snapshotResult, queueResult, actionsResult] = await Promise.allSettled([
    getDashboardSnapshot(),
    listGenerations(100),
    listActions(100)
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
          <p className="eyebrow">VAELONS / v0.8.0</p>
          <h1>Mağaza paneli</h1>
        </div>
        <div className="modePill"><span className="statusDot" /> {snapshot?.write_lock !== false ? 'Etsy yayını kapalı' : 'Etsy yayını onaya bağlı'}</div>
      </header>

      <PendingReviews
        actions={actionsResult.status === 'fulfilled' ? actionsResult.value : []}
        listings={snapshot?.catalog?.listings || []}
        error={actionsResult.status === 'rejected' ? actionsResult.reason : null}
      />

      {error ? (
        <section className="errorPanel">
          <b>Control Center henüz Etsy verisini okuyamadı.</b>
          <p>{error}</p>
          <small>Write lock aktif kaldı; Etsy’de değişiklik yapılmadı.</small>
        </section>
      ) : (
        <>
          <div id="catalog">
            <CatalogClient listings={snapshot.catalog.listings} />
          </div>
          <details className="disclosure systemDisclosure">
            <summary>Sistem ve denetim ayrıntıları</summary>
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

          </details>
        </>
      )}
      <BackgroundQueuePanel task={backgroundTask} queueError={queueError}
        receipts={verifiedTaskReceipts(
          queueResult.status === 'fulfilled' ? queueResult.value : [],
          actionsResult.status === 'fulfilled' ? actionsResult.value : []
        )} />
    </main>
  );
}
