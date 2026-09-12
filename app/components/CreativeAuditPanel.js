const signalLabels = {
  PASS: 'PASS',
  PARTIAL: 'PARTIAL',
  REVIEW: 'REVIEW',
  UNKNOWN: 'UNKNOWN',
  FAIL: 'FAIL'
};

export default function CreativeAuditPanel({ audit }) {
  return (
    <section className="panel creativeAuditPanel">
      <div className="sectionHeading compact">
        <div>
          <p className="eyebrow">CREATIVE AUDIT v{audit.version}</p>
          <h2>Görsel doğrulama</h2>
        </div>
        <span className={`statusBadge status-${audit.status}`}>{audit.status}</span>
      </div>

      <div className="creativeScoreboard">
        <div>
          <span>Technical integrity</span>
          <strong>{audit.technical_integrity_score}</strong>
          <small>Dosya, rank ve çözünürlük</small>
        </div>
        <div>
          <span>Visual quality</span>
          <strong>{audit.visual_quality_score ?? '—'}</strong>
          <small>Sezar incelemeden puanlanmaz</small>
        </div>
        <div>
          <span>Creative readiness</span>
          <strong>{audit.creative_readiness ?? '—'}</strong>
          <small>Artwork lock + Sezar incelemesi gerekir</small>
        </div>
      </div>

      <div className="artworkLockWarning">
        <div className="lockGlyph">AL</div>
        <div>
          <strong>Artwork source henüz kilitlenmedi</strong>
          <p>{audit.artwork_lock.requirement}</p>
          <small>Image manifest: {audit.manifest_hash.slice(0, 12)}…</small>
        </div>
      </div>

      <div className="signalGrid">
        {audit.signals.map((item) => (
          <div className="signalCard" key={item.id}>
            <span>{item.label}</span>
            <strong className={`signal-${item.status}`}>{signalLabels[item.status]}</strong>
            <small>{item.evidence}</small>
          </div>
        ))}
      </div>

      <div className="roleSection">
        <div className="sectionHeading compact">
          <div>
            <p className="eyebrow">10-IMAGE BLUEPRINT</p>
            <h3>Görsel rol matrisi</h3>
          </div>
          <span className="statusBadge status-VISION_REQUIRED">SEZAR REVIEW WAITING</span>
        </div>
        <div className="roleGrid">
          {audit.required_roles.map((role, index) => (
            <div className="roleRow" key={role.id}>
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div><strong>{role.label}</strong><small>{role.purpose}</small></div>
              <b>{role.status}</b>
            </div>
          ))}
        </div>
      </div>

      {audit.findings.length > 0 && (
        <div className="creativeFindings">
          <p className="eyebrow">TECHNICAL FINDINGS</p>
          {audit.findings.map((item) => (
            <div className="creativeFinding" key={item.code}>
              <span className={`severity severity-${item.severity}`}>{item.severity}</span>
              <div>
                <strong>{item.message}</strong>
                <p>{item.evidence} · {item.next_action}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="noFakeScore">
        <strong>Neden puan eksik?</strong>
        <p>Görsel sayısı, hero’nun güçlü olduğunu kanıtlamaz. Artwork görünürlüğü, kırpılma, kompozisyon ve rol kapsamı Sezar incelemesi tamamlanmadan tahmin edilmiyor.</p>
      </div>
    </section>
  );
}
