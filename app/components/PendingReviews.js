import Image from 'next/image';
import Link from 'next/link';
import { METADATA_LABELS, selectPendingReviews } from '../../lib/control-center/review.js';

export default function PendingReviews({ actions = [], listings = [], error = null }) {
  const reviews = selectPendingReviews(actions);
  const catalog = new Map(listings.map((listing) => [String(listing.listing_id), listing]));

  return (
    <section className="pendingReviews" id="approvals" aria-labelledby="pending-reviews-title">
      <div className="sectionHeading">
        <div>
          <p className="eyebrow">SIRADAKİ ADIMIN</p>
          <h2 id="pending-reviews-title">Onayını bekleyenler</h2>
          <p className="sectionIntro">Hazırlanan metinleri incele, ardından nasıl ilerleyeceğine karar ver.</p>
        </div>
        {!error && <span className="reviewCount">{reviews.length} ürün</span>}
      </div>
      {error ? (
        <p className="formStatus error" role="status">Onay bekleyenler şu anda okunamadı. Sayfayı yenileyerek tekrar deneyebilirsin.</p>
      ) : reviews.length === 0 ? (
        <div className="reviewEmpty">
          <strong>Şu anda inceleme bekleyen taslak yok.</strong>
          <p>Hazırlık tamamlandığında ürün burada görünecek. Yeni bir iş için aşağıdan ürün seçebilirsin.</p>
        </div>
      ) : (
        <div className="reviewCards">
          {reviews.map((action) => {
            const listing = catalog.get(String(action.listing_id));
            const title = action.proposed?.title || listing?.title || `Ürün #${action.listing_id}`;
            return (
              <article className="reviewCard" key={action.id}>
                <div className="reviewThumb">
                  {listing?.hero_url ? (
                    <Image src={listing.hero_url} alt={title} fill sizes="120px" />
                  ) : <span>Görsel yok</span>}
                </div>
                <div className="reviewCardBody">
                  <span className="cleanBadge">İncelemeye hazır</span>
                  <h3>{title}</h3>
                  <p>{action.changed_fields.map((field) => METADATA_LABELS[field]).join(' · ')} hazırlanmış</p>
                  <small>Ürün #{action.listing_id} · Henüz Etsy’ye uygulanmadı</small>
                </div>
                <Link className="primaryButton reviewLink" href={`/listings/${action.listing_id}?action=${action.id}`}>
                  Değişiklikleri incele <span aria-hidden="true">→</span>
                </Link>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
