'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/#approvals', label: 'Onay bekleyenler', code: 'ON' },
  { href: '/#catalog', label: 'Ürünler', code: 'ÜR' },
  { href: '/actions', label: 'İşlem geçmişi', code: 'İŞ' }
];

export default function AppNav() {
  const pathname = usePathname();

  return (
    <aside className="appNav">
      <Link className="navBrand" href="/" aria-label="VAELONS Control Center ana sayfa">
        <span className="navMonogram">V</span>
        <span>
          <strong>VAELONS</strong>
          <small>CONTROL CENTER</small>
        </span>
      </Link>

      <nav className="navLinks" aria-label="Ana menü">
        {items.map((item) => {
          const baseHref = item.href.split('#')[0] || '/';
          const active = baseHref === '/'
            ? pathname === '/' && item.href === '/#approvals'
            : pathname.startsWith(baseHref);

          return (
            <Link className={active ? 'navLink active' : 'navLink'} href={item.href} key={item.href}>
              <span>{item.code}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <details className="navDetails">
        <summary>Ayrıntılar</summary>
        <Link className="navLink" href="/creative">Görsel inceleme</Link>
        <Link className="navLink" href="/health">Sistem sağlığı</Link>
      </details>

      <div className="navSafety">
        <span className="statusDot" />
        <div>
          <strong>STAGING</strong>
          <small>Canlı mağaza korumalı</small>
        </div>
      </div>
    </aside>
  );
}
