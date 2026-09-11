export const metadata = {
  title: 'VAELONS Control Center',
  description: 'Private operating system for the VAELONS Etsy shop'
};

import './globals.css';

export default function RootLayout({ children }) {
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
