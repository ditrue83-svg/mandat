import Link from "next/link";
export default function NotFound() {
  return (
    <main className="content-narrow">
      <section className="panel space-top">
        <h1>Questa opportunità non è disponibile.</h1>
        <p>
          Il collegamento potrebbe essere cambiato dopo una nuova pubblicazione,
          oppure il bando potrebbe non essere disponibile per il tuo account.
        </p>
        <Link href="/" className="button primary space-top">
          Torna a Per la tua ditta
        </Link>
        <p className="space-top">
          <Link href="/esplora" className="text-link">
            Cerca la pubblicazione in Tutti i bandi
          </Link>
        </p>
      </section>
    </main>
  );
}
