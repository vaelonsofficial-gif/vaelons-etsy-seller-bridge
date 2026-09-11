import CatalogClient from './components/CatalogClient.js';
import { getDashboardSnapshot } from '../lib/control-center/catalog.js';

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

  try {
    snapshot = await getDashboardSnapshot();
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <div className="brand">VAELONS</div>
          <div className="productName">CONTROL CENTER</div>
        </div>
        <div className="modePill"><span className="dot" /> READ ONLY · WRITE LOCKED</div>
      </header>

      <section className="hero">
        <p className="eyebrow">OPERATIONS / v0.1</p>
        <h1>Mağazayı tek ekrandan gör, ölç, düzelt.</h1>
        <p>İlk sürüm Etsy kataloğunu canlı okur ve baseline conversion audit üretir. Bu branch Etsy’ye hiçbir değişiklik yazamaz.</p>
      </section>

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
            <StatCard label="Hero adayı" value={snapshot.decisions.HERO_CANDIDATE || 0} sub="Baseline score ≥ 88" />
            <StatCard label="Repair / Blocked" value={(snapshot.decisions.REPAIR || 0) + (snapshot.decisions.BLOCKED || 0)} sub="Reklamdan önce iyileştirme" />
          </section>

          <section className="notice">
            <div>
              <b>Bu skorlar karar motorunun ilk baseline sürümüdür.</b>
              <p>Ads spend, CTR, favori, sepet, sipariş ve marj verisi henüz bağlanmadığı için reklam kararı otomatik uygulanmaz.</p>
            </div>
            <div className="syncInfo">Son canlı okuma<br /><strong>{new Date(snapshot.generated_at).toLocaleString('tr-TR')}</strong></div>
          </section>

          <CatalogClient listings={snapshot.catalog.listings} />
        </>
      )}
    </main>
  );
}
