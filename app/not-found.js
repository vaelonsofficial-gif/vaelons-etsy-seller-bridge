import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="pageShell">
      <section className="emptyState panel standaloneError">
        <span>404</span>
        <h1>Listing bulunamadı</h1>
        <p>Listing silinmiş, erişime kapalı veya VAELONS mağazasına ait olmayabilir.</p>
        <Link className="primaryButton inlineButton" href="/#catalog">Kataloğa dön</Link>
      </section>
    </main>
  );
}
