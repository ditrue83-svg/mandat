"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertCircle, RefreshCw } from "lucide-react";
import { Shell } from "./shell";
import { BandiNavigation, type BandiCollection } from "./bandi-navigation";

export function LoadingContent({
  kind = "cards",
}: {
  kind?: "cards" | "profile" | "detail";
}) {
  return (
    <section
      className="page-loading"
      aria-busy="true"
      aria-label="Caricamento in corso"
    >
      <p role="status" className="loading-caption">
        <span className="loading-dot" aria-hidden="true" /> Apro la pagina…
      </p>
      <p className="sr-only">
        Sto preparando i bandi e i filtri della raccolta.
      </p>
      <div className={`skeleton-content skeleton-${kind}`} aria-hidden="true">
        <div className="skeleton-toolbar" />
        <div className="skeleton-grid">
          {[0, 1, 2].map((n) => (
            <div className="panel skeleton-card" key={n}>
              <span className="skeleton-line short" />
              <span className="skeleton-line" />
              <span className="skeleton-line" />
              <span className="skeleton-line medium" />
              <span className="skeleton-action" />
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function RouteLoading({ previewPath }: { previewPath?: string }) {
  const pathname = usePathname();
  const path = previewPath ?? pathname;
  const collection: BandiCollection =
    path === "/salvati"
      ? "saved"
      : path.startsWith("/esplora")
        ? "catalog"
        : "radar";
  const detail = /^\/(esplora|bandi)\/.+/.test(path);
  const profile = path === "/profilo";
  return (
    <Shell>
      {profile ? (
        <header className="page-heading">
          <h1>La tua ditta</h1>
        </header>
      ) : detail ? (
        <p className="eyebrow">DETTAGLIO DEL BANDO</p>
      ) : (
        <BandiNavigation active={collection} />
      )}
      <LoadingContent
        kind={profile ? "profile" : detail ? "detail" : "cards"}
      />
    </Shell>
  );
}

export function PageLoadError({ reset }: { reset: () => void }) {
  return (
    <Shell>
      <section className="empty-state panel page-load-error" role="alert">
        <AlertCircle size={32} aria-hidden="true" />
        <h1>La pagina non si è caricata</h1>
        <p>
          Si è verificato un problema nel caricamento dei dati. Non è un
          risultato della ricerca: prova di nuovo.
        </p>
        <button type="button" className="button primary" onClick={reset}>
          <RefreshCw size={17} aria-hidden="true" />
          Riprova
        </button>
        <Link className="text-link" href="/esplora">
          Torna a Tutti i bandi
        </Link>
      </section>
    </Shell>
  );
}
