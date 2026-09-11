'use client';

import { useMemo, useState } from 'react';

const decisionLabels = {
  HERO_CANDIDATE: 'Hero adayı',
  TEST_CANDIDATE: 'Test adayı',
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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return listings.filter((item) => {
      const matchesQuery = !q || item.title.toLowerCase().includes(q) || String(item.listing_id).includes(q);
      const matchesDecision = decision === 'ALL' || item.audit.decision === decision;
      return matchesQuery && matchesDecision;
    });
  }, [listings, query, decision]);

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
            <option value="HERO_CANDIDATE">Hero adayları</option>
            <option value="TEST_CANDIDATE">Test adayları</option>
            <option value="REPAIR">Onarım gerekli</option>
            <option value="BLOCKED">Reklama kapalı</option>
          </select>
        </div>
      </div>

      <div className="resultMeta">{filtered.length} / {listings.length} listing gösteriliyor</div>

      <div className="listingGrid">
        {filtered.map((listing) => (
          <article className="listingCard" key={listing.listing_id}>
            <div className="imageWrap">
              {listing.hero_url ? <img src={listing.hero_url} alt="" /> : <div className="imagePlaceholder">Görsel yok</div>}
              <span className={`decisionBadge decision-${listing.audit.decision}`}>{decisionLabels[listing.audit.decision]}</span>
            </div>
            <div className="listingBody">
              <div className="listingTopline">
                <span>#{listing.listing_id}</span>
                <strong>{money(listing.price)}</strong>
              </div>
              <h3>{listing.title}</h3>
              <div className="scores">
                <div><span>Conversion</span><b>{listing.audit.conversion_readiness}</b></div>
                <div><span>Hero/Image</span><b>{listing.audit.image_score}</b></div>
                <div><span>SEO</span><b>{listing.audit.seo_score}</b></div>
                <div><span>Trust</span><b>{listing.audit.trust_score}</b></div>
              </div>
              <div className="cardFooter">
                <span>{listing.image_count} görsel</span>
                <span>{listing.tags.length} tag</span>
                <span>READ ONLY</span>
              </div>
              {listing.audit.findings.length > 0 && (
                <ul className="findings">
                  {listing.audit.findings.slice(0, 2).map((finding) => <li key={finding}>{finding}</li>)}
                </ul>
              )}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
