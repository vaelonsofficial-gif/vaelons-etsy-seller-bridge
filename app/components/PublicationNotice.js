import { publicationStatus } from '../../lib/control-center/publication-status.js';

export default function PublicationNotice({ writePolicy, listingId = null }) {
  const status = publicationStatus(writePolicy, listingId);
  if (status.canPublish) return null;

  return (
    <aside className="publicationNotice" aria-label="Onay neden kapalı?">
      <h3>Onay neden kapalı?</h3>
      <p>“Onayla ve Etsy’de yayınla” düğmesi metinleri mağazana uygular. Şu anda yayın erişimi kapalı:</p>
      <ul>{status.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p>Taslağı açıp inceleyebilir veya Sezar’dan düzeltme isteyebilirsin.</p>
    </aside>
  );
}
