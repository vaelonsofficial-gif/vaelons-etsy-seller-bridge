export const metadata = {
  title: 'VAELONS Control Center',
  description: 'Private operating system for the VAELONS Etsy shop',
  robots: { index: false, follow: false }
};

import './globals.css';
import AppNav from './components/AppNav.js';

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <body>
        <div className="appFrame">
          <AppNav />
          <div className="appContent">{children}</div>
        </div>
      </body>
    </html>
  );
}
