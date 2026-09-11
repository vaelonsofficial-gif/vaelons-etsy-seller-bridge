import Link from 'next/link';

import { listActions } from '../../lib/control-center/store.js';
import { getWritePolicy } from '../../lib/control-center/write-policy.js';

export const dynamic = 'force-dynamic';

export default async function ActionsPage() {
  const policy = getWritePolicy();
  let actions = [];
  let error = null;

  try {
    actions = await listActions(100);
  } catch (cause) {
    error = cause?.message || String(cause);
  }

  return (
    <main className="pageShell">
      <header className="pageTopbar">
        <div>
          <p className="eyebrow">OPERATIONS</p>
          <h1>İşlem Kuyruğu</h1>
        </div>
        <div className="modePill"><span className="statusDot" /> {policy.mode} · {policy.write_locked ? 'LOCKED' : 'READY'}</div>
      </header>

      <section className="hero compactHero">
        <h2>Her değişiklik izlenebilir ve geri alınabilir.</h2>
        <p>Hazırlanan, engellenen, uygulanan ve geri alınan listing işlemleri tek zaman çizgisinde tutulur.</p>
      </section>

      {error ? (
        <section className="errorPanel">
          <b>İşlem deposu okunamadı.</b>
          <p>{error}</p>
        </section>
      ) : actions.length === 0 ? (
        <section className="emptyState panel">
          <span>AQ</span>
          <h2>Kuyruk henüz boş</h2>
          <p>Bir listingin detay ekranından değişiklik taslağı oluşturduğunda burada görünecek.</p>
          <Link className="primaryButton inlineButton" href="/#catalog">Listinglere git</Link>
        </section>
      ) : (
        <section className="panel actionTablePanel">
          <div className="actionTable">
            <div className="actionTableHead">
              <span>Durum</span><span>Listing</span><span>Değişiklik</span><span>Oluşturma</span><span></span>
            </div>
            {actions.map((action) => (
              <div className="actionTableRow" key={action.id}>
                <span><b className={`statusBadge status-${action.status}`}>{action.status}</b></span>
                <span>#{action.listing_id}</span>
                <span>{action.changed_fields.join(', ')}</span>
                <span>{new Date(action.created_at).toLocaleString('tr-TR')}</span>
                <span><Link href={`/listings/${action.listing_id}`}>Aç →</Link></span>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
