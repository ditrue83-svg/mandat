"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="content-narrow">
      <section className="panel space-top">
        <h1>Qualcosa si è fermato.</h1>
        <p>
          Non siamo riusciti a caricare questa pagina. Le tue preferenze salvate
          sono al sicuro.
        </p>
        <button className="button primary space-top" onClick={reset}>
          Riprova
        </button>
      </section>
    </main>
  );
}
