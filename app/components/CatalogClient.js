'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

const PAGE_SIZE = 24;

const decisionLabels = {
  REVIEW_REQUIRED: 'Görsel inceleme',
  REPAIR: 'Onarım gerekli',
  BLOCKED: 'Reklama kapalı'
};

function money(price) {
  if (!price || price.amount === null || price.amount === undefined) return '—';
  try {
    return new Intl.NumberFormat('tr-TR', {
      style: price.currency ? 'currency' : 'decimal',
      currency: price.currency || undefined,
      maximumFractionDigits: 0
    }).format(price.amount);
  } catch {
    return `${Math.round(price.amount)} ${price.currency || ''}`.trim();
  }
}

export default function CatalogClient({ listings }) {
  const [query, setQuery] = useState('');
  const [decision, setDecision] = useState('ALL');
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listings.filter((item) => {
      const matchesQuery = !q || item.title.toLowerCase().includes(q) || String(item.listing_id).includes(q);
      const matchesDecision = decision === 'ALL' || item.audit.decision === decision;
      return matchesQuery && matchesDecision;
    });
  }, [listings, query, decision]);

  useEffect(() => setPage(1), [query, decision]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const start = (safePage - 1) * PAGE_SIZE;
  const visible = filtered.slice(start, start + PAGE_SIZE);

  return (
    <section className="catalogSection">
      <div className="toolbar">
        <div>
          <p className="eyebrow">CATALOG AUDIT</p>
          <h2>Listing kontrol merkezi</h2>
        </div>
        <div className="filters">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Başlık veya listing ID ara" />
          <select value={decision} onChange={(event) => setDecision(event.target.value)}>
            <option value="ALL">Tüm kararlar</option>
            <option value="REVIEW_REQUIRED">Görsel inceleme bekleyenler</option>
            <option value="REPAIR">Onarım gerekli</option>
            <option value="BLOCKED">Reklama kapalı</option>
          </select>
        </div>
      </div>

      <div className="resultMeta">
        {filtered.length === 0 ? 'Sonuç bulunamadı' : `${start + 1}–${Math.min(start + PAGE_SIZE, filtered.length)} / ${filtered.length} listing`}
      </div>

      <div className="listingGrid">
        {visible.map((listing) => (
          <article className="listingCard" key={listing.listing_id}>
            <div className="imageWrap">
              {listing.hero_url ? (
                <Image
                  src={listing.hero_url}
                  alt={`${listing.title} ana görseli`}
                  fill
                  sizes="(max-width: 760px) 100vw, (max-width: 1180px) 50vw, 33vw"
                />
              ) : <div className="imagePlaceholder">Görsel yok</div>}
              <span className={`decisionBadge decision-${listing.audit.decision}`}>{decisionLabels[listing.audit.decision]}</span>
            </div>
            <div className="listingBody">
              <div className="listingTopline">
                <span>#{listing.listing_id}</span>
                <strong>{money(listing.price)}</strong>
              </div>
              <h3>{listing.title}</h3>
              <div className="scores">
                <div><span>Metadata</span><b>{listing.audit.metadata_readiness}</b></div>
                <div><span>Image Set</span><b>{listing.audit.image_score}</b></div>
                <div><span>SEO</span><b>{listing.audit.seo_score}</b></div>
                <div><span>Trust</span><b>{listing.audit.trust_score}</b></div>
              </div>
              <div className="cardFooter">
                <span>{listing.image_count} görsel</span>
                <span>{listing.tags.length} tag</span>
                <span>ADS LOCKED</span>
              </div>
              {listing.audit.findings.length > 0 && (
                <ul className="findings">
                  {listing.audit.findings.slice(0, 2).map((finding) => <li key={finding}>{finding}</li>)}
                </ul>
              )}
              <Link className="cardAction" href={`/listings/${listing.listing_id}`}>Listingi incele <span>→</span></Link>
            </div>
          </article>
        ))}
      </div>

      {filtered.length > PAGE_SIZE && (
        <nav className="pagination" aria-label="Katalog sayfaları">
          <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={safePage === 1}>Önceki</button>
          <span>Sayfa {safePage} / {pageCount}</span>
          <button type="button" onClick={() => setPage((value) => Math.min(pageCount, value + 1))} disabled={safePage === pageCount}>Sonraki</button>
        </nav>
      )}
    </section>
  );
}
