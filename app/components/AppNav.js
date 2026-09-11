'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const items = [
  { href: '/', label: 'Genel Bakış', code: 'OV' },
  { href: '/#catalog', label: 'Listingler', code: 'LS' },
  { href: '/creative', label: 'Creative Audit', code: 'CR' },
  { href: '/actions', label: 'İşlem Kuyruğu', code: 'AQ' },
  { href: '/health', label: 'Sistem Sağlığı', code: 'SH' }
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
            ? pathname === '/' && item.href === '/'
            : pathname.startsWith(baseHref);

          return (
            <Link className={active ? 'navLink active' : 'navLink'} href={item.href} key={item.href}>
              <span>{item.code}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

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
