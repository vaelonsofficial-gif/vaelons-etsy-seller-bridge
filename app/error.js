'use client';

export default function ErrorPage({ reset }) {
  return (
    <main className="pageShell">
      <section className="errorPanel standaloneError">
        <b>Control Center bu ekranı tamamlayamadı.</b>
        <p>Güvenlik nedeniyle hiçbir Etsy değişikliği yapılmadı.</p>
        <button className="secondaryButton" type="button" onClick={() => reset()}>Tekrar dene</button>
      </section>
    </main>
  );
}
