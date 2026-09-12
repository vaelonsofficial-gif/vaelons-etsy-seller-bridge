import CreativeQueueClient from '../components/CreativeQueueClient.js';
import { getDashboardSnapshot } from '../../lib/control-center/catalog.js';
import { getVisionPolicy } from '../../lib/control-center/vision-policy.js';

export const dynamic = 'force-dynamic';

function Metric({ label, value, detail }) {
  return (
    <div className="statCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

export default async function CreativePage() {
  let snapshot;
  let error = null;

  try {
    snapshot = await getDashboardSnapshot();
  } catch (cause) {
    error = cause?.message || String(cause);
  }

  const vision = getVisionPolicy();
  const queueListings = snapshot?.catalog.listings.map((listing) => ({
    listing_id: listing.listing_id,
    title: listing.title,
    image_count: listing.image_count,
    hero_url: listing.hero_url,
    creative_preview: {
      status: listing.creative_preview.status,
      technical_integrity_score: listing.creative_preview.technical_integrity_score,
      vision_status: listing.creative_preview.vision_status,
      primary_finding: listing.creative_preview.primary_finding
    }
  })) || [];

  return (
    <main className="pageShell">
      <header className="pageTopbar">
        <div>
          <p className="eyebrow">CREATIVE OPERATIONS / v0.6</p>
          <h1>Creative Audit</h1>
        </div>
        <div className="modePill"><span className="statusDot" /> {vision.status}</div>
      </header>

      <section className="hero compactHero">
        <h2>Görsel sayısını değil, satış görevini denetle.</h2>
        <p>Her listing artwork doğruluğu, hero gücü, ölçek algısı ve 10 görsel rolüyle incelenir. Sezar görsel incelemesi tamamlanmadan kalite puanı üretilmez.</p>
      </section>

      {error ? (
        <section className="errorPanel"><b>Creative queue oluşturulamadı.</b><p>{error}</p></section>
      ) : (
        <>
          <section className="statsGrid">
            <Metric label="Sezar incelemesi" value={snapshot.summary.visual_review_count} detail="Görsel karar bekliyor" />
            <Metric label="Teknik blokaj" value={snapshot.summary.creative_blocked_count} detail="Image ID, rank veya URL kontrolü" />
            <Metric label="10 slot altı" value={snapshot.summary.role_capacity_short_count} detail="Blueprint kapasitesi yetersiz" />
            <Metric label="Artwork locked" value="0" detail="Kaynak doğrulaması olmadan üretim yok" />
          </section>
          <section className="creativeSafetyBanner">
            <strong>Artwork locked product kuralı aktif.</strong>
            <p>Kaynak artwork seçilmeden, referans parmak izi oluşturulmadan ve Sezar incelemesi tamamlanmadan yeni mockup üretimi veya Etsy upload işlemi açılamaz.</p>
          </section>
          <CreativeQueueClient listings={queueListings} />
        </>
      )}
    </main>
  );
}
