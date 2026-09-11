import Link from "next/link";
export default function NotFound() {
  return (
    <main className="content-narrow">
      <section className="panel space-top">
        <h1>Questa opportunità non è disponibile.</h1>
        <p>
          Il collegamento potrebbe non essere valido o il bando non essere
          presente nel tuo Radar.
        </p>
        <Link href="/" className="button primary space-top">
          Torna al Radar
        </Link>
      </section>
    </main>
  );
}
