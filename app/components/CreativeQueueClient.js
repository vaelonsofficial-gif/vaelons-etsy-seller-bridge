'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useDeferredValue, useMemo, useState } from 'react';

const PAGE_SIZE = 40;

export default function CreativeQueueClient({ listings }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const deferredQuery = useDeferredValue(query);

  const filtered = useMemo(() => {
    const normalizedQuery = deferredQuery.trim().toLocaleLowerCase('tr-TR');
    return listings.filter((listing) => {
      const matchesQuery = !normalizedQuery ||
        listing.title.toLocaleLowerCase('tr-TR').includes(normalizedQuery) ||
        String(listing.listing_id).includes(normalizedQuery);
      const matchesStatus = status === 'ALL' || listing.creative_preview.status === status;
      return matchesQuery && matchesStatus;
    });
  }, [listings, deferredQuery, status]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visibleListings = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <section className="panel creativeQueuePanel">
      <div className="toolbar creativeToolbar">
        <div>
          <p className="eyebrow">REVIEW QUEUE</p>
          <h2>{filtered.length} listing</h2>
        </div>
        <div className="filters">
          <input
            aria-label="Creative listing ara"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="Başlık veya listing ID ara"
          />
          <select
            aria-label="Creative audit durumuna göre filtrele"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="ALL">Tüm durumlar</option>
            <option value="BLOCKED">Teknik blokaj</option>
            <option value="VISION_REQUIRED">Vision bekliyor</option>
          </select>
        </div>
      </div>

      <div className="creativeQueueTable" role="table" aria-label="Creative audit kuyruğu">
        <div className="creativeQueueHead" role="row">
          <span role="columnheader">Listing</span><span role="columnheader">Teknik</span><span role="columnheader">Artwork lock</span><span role="columnheader">Vision</span><span role="columnheader">Öncelikli bulgu</span><span role="columnheader">Aksiyon</span>
        </div>
        {visibleListings.map((listing) => (
          <div className="creativeQueueRow" key={listing.listing_id} role="row">
            <div className="queueListing" role="cell">
              <div className="queueThumb">
                {listing.hero_url ? <Image src={listing.hero_url} alt="" fill sizes="56px" /> : <span>—</span>}
              </div>
              <div><strong>{listing.title}</strong><small>#{listing.listing_id} · {listing.image_count} görsel</small></div>
            </div>
            <span className="queueScore" role="cell">{listing.creative_preview.technical_integrity_score}</span>
            <span role="cell"><span className="queueState blockedState">SOURCE REQUIRED</span></span>
            <span role="cell"><span className="queueState waitingState">{listing.creative_preview.vision_status}</span></span>
            <span className="queueFinding" role="cell">{listing.creative_preview.primary_finding}</span>
            <span role="cell"><Link href={`/listings/${listing.listing_id}`}>İncele →</Link></span>
          </div>
        ))}
      </div>
      {filtered.length > PAGE_SIZE ? (
        <div className="queuePagination" aria-label="Creative audit sayfaları">
          <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={safePage === 1}>← Önceki</button>
          <span>Sayfa {safePage} / {pageCount}</span>
          <button type="button" onClick={() => setPage((current) => Math.min(pageCount, current + 1))} disabled={safePage === pageCount}>Sonraki →</button>
        </div>
      ) : null}
    </section>
  );
}
