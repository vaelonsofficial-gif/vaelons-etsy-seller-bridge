import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { fetchListingDetail } from '../../../lib/control-center/catalog.js';
import { getAction, listActions } from '../../../lib/control-center/store.js';
import { publicAction } from '../../../lib/control-center/actions.js';
import { selectPendingReviews } from '../../../lib/control-center/review.js';
import CreativeAuditPanel from '../../components/CreativeAuditPanel.js';
import ListingEditor from './ListingEditor.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function money(price) {
  if (!price) return '—';
  return new Intl.NumberFormat('tr-TR', {
    style: price.currency ? 'currency' : 'decimal',
    currency: price.currency || undefined,
    maximumFractionDigits: 0
  }).format(price.amount);
}

export default async function ListingDetailPage({ params, searchParams }) {
  const { listingId } = await params;
  const query = await searchParams;
  let listing;
  let initialAction = null;

  try {
    listing = await fetchListingDetail(listingId);
    if (query?.action) {
      const candidate = await getAction(String(query.action));
      if (candidate && String(candidate.listing_id) === String(listingId)) initialAction = candidate;
    } else {
      initialAction = selectPendingReviews(await listActions(100))
        .find((action) => String(action.listing_id) === String(listingId)) || null;
    }
  } catch (error) {
    if (error?.status === 404 || error?.status === 400) notFound();
    throw error;
  }

  return (
    <main className={`pageShell reviewPage${initialAction ? ' hasApprovalDock' : ''}`}>
      <header className="pageTopbar detailTopbar">
        <div>
          <Link className="backLink" href="/#approvals">← Mağaza paneline dön</Link>
          <p className="eyebrow">LISTING #{listing.listing_id}</p>
          <h1>{listing.title}</h1>
        </div>
        <div className="detailMeta">
          <strong>{money(listing.price)}</strong>
          <span className="modePill"><span className="statusDot" /> {listing.write_policy.write_locked ? 'Etsy yayını kapalı' : 'Etsy yayını onaya bağlı'}</span>
        </div>
      </header>

      {query?.action && !initialAction && <p className="formStatus error" role="status">Bu ürüne ait taslak bulunamadı. Ana ekrandaki onay bekleyenleri kontrol et.</p>}
      <ListingEditor
        key={initialAction?.id || listing.listing_id}
        listing={listing}
        writePolicy={listing.write_policy}
        contentPolicy={listing.content_policy}
        initialAction={publicAction(initialAction)}
      />
      <details className="disclosure productDetails">
        <summary>Ürün görselleri ve denetim ayrıntıları</summary>
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

      </details>
    </main>
  );
}
