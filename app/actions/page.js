import Link from 'next/link';

import { classifyGenerationError } from '../../lib/control-center/content-generator.js';
import { listActions, listGenerations } from '../../lib/control-center/store.js';
import { getWritePolicy } from '../../lib/control-center/write-policy.js';
import PendingReviews from '../components/PendingReviews.js';

export const dynamic = 'force-dynamic';

function generationStatus(generation) {
  const error = generation.error ? classifyGenerationError(generation.error) : null;
  if (['QUEUED', 'IN_PROGRESS'].includes(generation.status)) {
    return {
      heading: generation.task_scope || 'FULL_LISTING',
      detail: generation.status === 'IN_PROGRESS'
        ? 'Sezar içeriği arka planda hazırlıyor.'
        : generation.command
    };
  }
  return {
    heading: error?.code || generation.task_scope || generation.response_model || generation.model,
    detail: error?.message || generation.summary || 'İşlem sürüyor'
  };
}

export default async function ActionsPage() {
  const policy = getWritePolicy();
  const [actionResult, generationResult] = await Promise.allSettled([
    listActions(100),
    listGenerations(100)
  ]);
  const actions = actionResult.status === 'fulfilled' ? actionResult.value : [];
  const generations = generationResult.status === 'fulfilled' ? generationResult.value : [];
  const errors = [actionResult, generationResult]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason?.message || String(result.reason));

  return (
    <main className="pageShell">
      <header className="pageTopbar">
        <div>
          <p className="eyebrow">OPERATIONS</p>
          <h1>İşlem geçmişi</h1>
        </div>
        <div className="modePill"><span className="statusDot" /> {policy.write_locked ? 'Etsy yayını kapalı' : 'Etsy yayını onaya bağlı'}</div>
      </header>

      <PendingReviews actions={actions} error={actionResult.status === 'rejected' ? actionResult.reason : null} />

      {errors.length > 0 && (
        <section className="errorPanel">
          <b>İşlem kayıtlarının bir bölümü okunamadı.</b>
          <p>{errors.join(' · ')}</p>
        </section>
      )}

      <details className="operationsSection disclosure">
        <summary>Hazırlama geçmişi · {generations.length} kayıt</summary>
        <div className="sectionHeading operationsHeading">
          <div>
            <p className="eyebrow">SEZAR WORK QUEUE</p>
            <h2>İyileştirme görevleri</h2>
          </div>
          <span className="modePill">{generations.length} KAYIT</span>
        </div>

        {generations.length === 0 ? (
          <section className="emptyState compactEmpty panel">
            <span>SZ</span>
            <h2>Henüz Sezar görevi yok</h2>
            <p>Bir listing seçip komut verdiğinde ücretsiz görev, sonuç ve güvenlik kaydı burada görünür.</p>
          </section>
        ) : (
          <section className="panel actionTablePanel">
            <div className="actionTable generationOperationsTable">
              <div className="actionTableHead generationOperationsRow">
                <span>Durum</span><span>Listing</span><span>Kapsam / görev</span><span>Oluşturma</span><span></span>
              </div>
              {generations.map((generation) => {
                const result = generationStatus(generation);
                return (
                  <div className="actionTableRow generationOperationsRow" key={generation.id}>
                    <span><b className={`statusBadge status-${generation.status}`}>{generation.status}</b></span>
                    <span>#{generation.listing_id}</span>
                    <span className="operationResult">
                      <strong>{result.heading}</strong>
                      <small>{result.detail}</small>
                    </span>
                    <span>{new Date(generation.created_at).toLocaleString('tr-TR')}</span>
                    <span><Link href={`/generations/${generation.id}`}>Kayıt →</Link></span>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </details>

      <details className="operationsSection disclosure">
        <summary>Değişiklik ve yayın geçmişi · {actions.length} kayıt</summary>
        <div className="sectionHeading operationsHeading">
          <div>
            <p className="eyebrow">ETSY ACTIONS</p>
            <h2>Değişiklik ve yayın kuyruğu</h2>
          </div>
          <span className="modePill">{actions.length} KAYIT</span>
        </div>

        {actions.length === 0 ? (
          <section className="emptyState compactEmpty panel">
            <span>AQ</span>
            <h2>Onay kuyruğu henüz boş</h2>
            <p>Doğrulanan bir içerik taslağı hazırlandığında Etsy’ye gidecek kesin fark burada görünür.</p>
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
                  <span><Link href={`/listings/${action.listing_id}?action=${action.id}`}>Aç →</Link></span>
                </div>
              ))}
            </div>
          </section>
        )}
      </details>
    </main>
  );
}
