import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { fetchListingDetail } from '../../../lib/control-center/catalog.js';
import CreativeAuditPanel from '../../components/CreativeAuditPanel.js';
import ListingEditor from './ListingEditor.js';

export const dynamic = 'force-dynamic';

function money(price) {
  if (!price) return '—';
  return new Intl.NumberFormat('tr-TR', {
    style: price.currency ? 'currency' : 'decimal',
    currency: price.currency || undefined,
    maximumFractionDigits: 0
  }).format(price.amount);
}

export default async function ListingDetailPage({ params }) {
  const { listingId } = await params;
  let listing;

  try {
    listing = await fetchListingDetail(listingId);
  } catch (error) {
    if (error?.status === 404 || error?.status === 400) notFound();
    throw error;
  }

  return (
    <main className="pageShell">
      <header className="pageTopbar detailTopbar">
        <div>
          <Link className="backLink" href="/#catalog">← Listinglere dön</Link>
          <p className="eyebrow">LISTING #{listing.listing_id}</p>
          <h1>{listing.title}</h1>
        </div>
        <div className="detailMeta">
          <strong>{money(listing.price)}</strong>
          <span className="modePill"><span className="statusDot" /> {listing.write_policy.mode}</span>
        </div>
      </header>

      <section className="detailGrid">
        <div className="detailRail">
          <section className="panel galleryPanel">
            <div className="sectionHeading compact">
              <div>
                <p className="eyebrow">CREATIVE SET</p>
                <h2>{listing.images.length} görsel</h2>
              </div>
              <span className="dirtyBadge">Artwork source required</span>
            </div>

            {listing.images[0]?.url_570xN ? (
              <div className="detailHeroImage">
                <Image
                  src={listing.images[0].url_fullxfull || listing.images[0].url_570xN}
                  alt={`${listing.title} ana görseli`}
                  fill
                  priority
                  sizes="(max-width: 1000px) 100vw, 42vw"
                />
                <span>HERO · RANK 1</span>
              </div>
            ) : <div className="imagePlaceholder">Ana görsel bulunamadı</div>}

            <div className="thumbnailGrid">
              {listing.images.slice(1).filter((image) => image.url_570xN || image.url_fullxfull).map((image) => (
                <div className="detailThumb" key={image.image_id}>
                  <Image
                    src={image.url_570xN || image.url_fullxfull}
                    alt={`${listing.title} görsel ${image.rank}`}
                    fill
                    sizes="(max-width: 760px) 33vw, 12vw"
                  />
                  <span>#{image.rank}</span>
                </div>
              ))}
            </div>
          </section>

          <CreativeAuditPanel audit={listing.creative_audit} />

          <section className="panel auditPanel">
            <div className="sectionHeading compact">
              <div>
                <p className="eyebrow">AUDIT SNAPSHOT</p>
                <h2>Metadata denetimi</h2>
              </div>
              <span className={`statusBadge status-${listing.audit.decision}`}>{listing.audit.decision}</span>
            </div>
            <div className="largeScores">
              <div><span>Metadata</span><strong>{listing.audit.metadata_readiness}</strong></div>
              <div><span>Image Set</span><strong>{listing.audit.image_score}</strong></div>
              <div><span>SEO</span><strong>{listing.audit.seo_score}</strong></div>
              <div><span>Trust</span><strong>{listing.audit.trust_score}</strong></div>
            </div>
            {listing.audit.claim_review_required && (
              <div className="claimRisk">
                <strong>Claim review gerekli</strong>
                <p>{listing.audit.unverified_claims.map((claim) => claim.label).join(' · ')}</p>
              </div>
            )}
            <ul className="auditFindings">
              {listing.audit.findings.map((finding) => <li key={finding}>{finding}</li>)}
            </ul>
          </section>
        </div>

        <ListingEditor listing={listing} writePolicy={listing.write_policy} />
      </section>
    </main>
  );
}
