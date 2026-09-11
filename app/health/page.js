import { getSystemHealth } from '../../lib/control-center/health.js';

export const dynamic = 'force-dynamic';

function CheckCard({ title, ok, detail, status }) {
  return (
    <div className="healthCard">
      <div className={ok ? 'healthIcon healthy' : 'healthIcon unhealthy'}>{ok ? '✓' : '!'}</div>
      <div>
        <span>{title}</span>
        <strong>{status || (ok ? 'HEALTHY' : 'ATTENTION')}</strong>
        <small>{detail}</small>
      </div>
    </div>
  );
}

export default async function HealthPage() {
  const health = await getSystemHealth();
  const token = health.checks.etsy_token;
  const identity = health.checks.shop_identity;
  const persistence = health.checks.persistence;
  const vision = health.vision_policy;

  return (
    <main className="pageShell">
      <header className="pageTopbar">
        <div>
          <p className="eyebrow">CONTROL PLANE / v{health.version}</p>
          <h1>Sistem Sağlığı</h1>
        </div>
        <div className="modePill"><span className="statusDot" /> {health.ok ? 'CORE HEALTHY' : 'CHECK REQUIRED'}</div>
      </header>

      <section className="healthGrid">
        <CheckCard
          title="Etsy OAuth"
          ok={token.ok && token.value?.connected}
          detail={token.ok ? 'Token bağlantısı mevcut' : token.error}
        />
        <CheckCard
          title="Shop Identity"
          ok={identity.ok && identity.value?.verified}
          detail={identity.ok ? `${identity.value.shop_name} · #${identity.value.shop_id}` : identity.error}
        />
        <CheckCard
          title="Action Store"
          ok={persistence.ok && persistence.value?.healthy}
          detail={persistence.ok && persistence.value?.healthy ? 'Kalıcı işlem deposu erişilebilir' : persistence.value?.reason || persistence.error}
        />
        <CheckCard
          title="Global Write Gate"
          ok
          status={health.write_policy.write_locked ? 'PROTECTED' : 'SAFE_WRITE READY'}
          detail={health.write_policy.write_locked ? 'Etsy yazma işlemleri güvenli şekilde kilitli' : 'SAFE_WRITE yürütmeye hazır'}
        />
        <CheckCard
          title="Vision Engine"
          ok={vision.ready}
          status={vision.status}
          detail={vision.ready ? `${vision.provider} · ${vision.model}` : 'AI görsel analizi henüz etkinleştirilmedi'}
        />
      </section>

      <section className="panel policyPanel">
        <div className="sectionHeading compact">
          <div>
            <p className="eyebrow">WRITE POLICY</p>
            <h2>{health.write_policy.mode}</h2>
          </div>
          <span className={health.write_policy.write_locked ? 'statusBadge status-BLOCKED' : 'statusBadge status-COMPLETED'}>
            {health.write_policy.write_locked ? 'LOCKED' : 'READY'}
          </span>
        </div>
        <div className="policyFacts">
          <div><span>Kill switch</span><strong>{health.write_policy.kill_switch_active ? 'ACTIVE' : 'OFF'}</strong></div>
          <div><span>Authentication</span><strong>{health.write_policy.authentication_ready ? 'READY' : 'PENDING'}</strong></div>
          <div><span>Allowed listing</span><strong>{health.write_policy.allowed_listing_id || 'NONE'}</strong></div>
        </div>
        {health.write_policy.blockers.length > 0 && (
          <ul className="auditFindings">
            {health.write_policy.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
          </ul>
        )}
        <p className="healthTimestamp">Son kontrol: {new Date(health.checked_at).toLocaleString('tr-TR')} · {health.duration_ms} ms</p>
      </section>
    </main>
  );
}
