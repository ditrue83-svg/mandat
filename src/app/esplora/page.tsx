import Link from "next/link";
import { ArrowRight, Search, MapPin, CalendarDays } from "lucide-react";
import { Shell } from "@/components/shell";
import { pageViewer } from "@/lib/viewer";
import {
  readCatalog,
  catalogHref,
  catalogDetailHref,
  CATALOG_STATUS_LABELS,
  type CatalogFilters,
  type CatalogSourceSummary,
} from "@/lib/catalog";
import { SECTORS, formatDate, formatDeadline, sectorLabel } from "@/lib/domain";
import { CatalogBookmark } from "@/components/catalog-bookmark";
import { TenderSourceButton } from "@/components/tender-brief";

export const dynamic = "force-dynamic";

function sourceHeadline(source: CatalogSourceSummary) {
  if (source.state === "disabled") return "non attivo nella beta";
  if (source.state === "error") return "problema nell’ultimo aggiornamento";
  if (source.state === "delayed") return "aggiornamento in ritardo";
  if (source.state === "unavailable") return "prima raccolta non disponibile";
  if (source.state === "updating") return "aggiornamento in corso";
  return "aggiornata";
}

export default async function Explore({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await pageViewer();
  const raw = await searchParams;
  const input: CatalogFilters = Object.fromEntries(
    Object.entries(raw).filter(([, value]) => typeof value === "string"),
  );
  const data = await readCatalog(viewer, input);
  return (
    <Shell viewer={viewer}>
      <section className="page-heading">
        <div>
          <div className="eyebrow">LE PUBBLICAZIONI RACCOLTE</div>
          <h1>Esplora bandi.</h1>
          <p>
            Cerca per lavoro, ente o luogo, anche fuori dalle preferenze della
            tua ditta.
          </p>
        </div>
        <Link href="/" className="button secondary">
          Il tuo Radar <ArrowRight size={17} />
        </Link>
      </section>
      <section
        className="panel catalog-panel"
        aria-label="Ricerca nei bandi raccolti"
      >
        <form action="/esplora" className="catalog-filters">
          <label className="catalog-search">
            Cosa cerchi?
            <span className="search-input">
              <Search size={18} />
              <input
                name="q"
                defaultValue={data.filters.q}
                key={data.filters.q}
                placeholder="Es. pulizia scuole, potatura, Lugano"
                maxLength={200}
              />
            </span>
          </label>
          <label>
            Settore indicativo
            <select
              name="settore"
              defaultValue={data.filters.settore}
              key={data.filters.settore}
            >
              <option value="all">Tutti</option>
              {SECTORS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Stato
            <select
              name="stato"
              defaultValue={data.filters.stato}
              key={data.filters.stato}
            >
              <option value="all">Tutti gli stati</option>
              {Object.entries(CATALOG_STATUS_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Ordina per
            <select
              name="ordine"
              defaultValue={data.filters.ordine}
              key={data.filters.ordine}
            >
              <option value="recenti">Più recenti</option>
              <option value="scadenza">Scadenza più vicina</option>
            </select>
          </label>
          <button className="button primary" type="submit">
            <Search size={17} /> Cerca
          </button>
        </form>
        <div className="catalog-results-heading">
          <p>
            <strong>{data.total}</strong>{" "}
            {data.total === 1 ? "risultato" : "risultati"} ·{" "}
            {data.collectedCount} pubblicazioni raccolte, {data.openCount} in
            corso
          </p>
          <Link href="/esplora?stato=all" className="text-link">
            Mostra tutto
          </Link>
        </div>
        <p className="meta">
          {viewer.demo
            ? "Dati dimostrativi inventati."
            : `Fonti: simap${data.foglioAvailable ? " e Foglio Ufficiale TI" : ". Foglio Ufficiale TI non ancora incluso"}. La raccolta attuale è dedicata al Ticino e non copre tutti gli appalti svizzeri.`}
        </p>
      </section>
      <div className="catalog-notice">
        <strong>La pertinenza per la tua ditta è da valutare.</strong>
        <p>
          Questi bandi sono consultabili prima della selezione nel Radar.
          Verifica requisiti e rettifiche sulla fonte ufficiale.
        </p>
        {!viewer.demo && (
          <div className="source-status-list" aria-label="Stato delle fonti">
            {data.sources.map((source) => {
              const problem =
                source.included &&
                ["error", "delayed", "unavailable"].includes(source.state);
              return (
                <div
                  className={`source-status ${source.state}`}
                  role={problem ? "alert" : "status"}
                  key={source.id}
                >
                  <strong>
                    {source.label}: {sourceHeadline(source)}.
                  </strong>
                  <span>
                    {source.state === "disabled"
                      ? " I contenuti restano esclusi finché non sarà confermato il loro riutilizzo."
                      : source.lastSuccessAt
                        ? ` Ultima raccolta completata: ${formatDeadline(source.lastSuccessAt)}.`
                        : " I bandi non sono ancora stati raccolti."}
                    {problem
                      ? " I dati già presenti restano consultabili, ma potrebbero mancare nuove pubblicazioni. Mandat riproverà automaticamente."
                      : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <section className="catalog-grid" aria-label="Risultati della ricerca">
        {data.items.map((p) => (
          <article className="panel catalog-card" key={p.id}>
            <div className="catalog-card-top">
              <span
                className={`status-tag ${p.status === "open" ? "good" : ""}`}
              >
                {CATALOG_STATUS_LABELS[p.status]}
              </span>
              <span className="meta">
                {p.source === "simap" ? "simap" : "Foglio TI"} ·{" "}
                {formatDate(p.publishedAt)}
              </span>
            </div>
            <h2>
              <Link href={catalogDetailHref(p.id, data.filters, data.page)}>
                {p.title}
              </Link>
            </h2>
            <p className="catalog-buyer">{p.buyer || "Ente non indicato"}</p>
            <div className="catalog-facts">
              <span>
                <MapPin size={16} />
                {p.location || "Luogo non indicato"}
              </span>
              <span>
                <CalendarDays size={16} />
                {p.deadline
                  ? `Scadenza ${formatDate(p.deadline)}`
                  : "Scadenza non indicata"}
              </span>
            </div>
            <p className="catalog-excerpt">
              {p.originalText ||
                "Apri la fonte ufficiale per leggere il contenuto."}
            </p>
            <div className="catalog-card-footer">
              <span className="meta">
                {p.sectors.map(sectorLabel).join(" · ") ||
                  "Settore da definire"}
              </span>
              <div className="catalog-card-actions">
                <CatalogBookmark
                  id={p.id}
                  title={p.title}
                  initialSaved={p.saved}
                  demo={viewer.demo}
                />
                <Link
                  href={catalogDetailHref(p.id, data.filters, data.page)}
                  className="text-link"
                >
                  Leggi il bando <ArrowRight size={16} />
                </Link>
              </div>
            </div>
            <div className="card-source-action">
              <TenderSourceButton
                publication={p}
                demo={viewer.demo}
                className="source-link"
              />
            </div>
          </article>
        ))}
      </section>
      {!data.items.length && (
        <section className="empty-state panel">
          <Search size={32} />
          <h2>Nessun bando con questi filtri.</h2>
          <p>
            Prova meno parole, un altro settore oppure includi i bandi scaduti.
            La ricerca riguarda solo le pubblicazioni già raccolte.
          </p>
          <Link href="/esplora?stato=all" className="button primary">
            Consulta tutte le pubblicazioni
          </Link>
        </section>
      )}
      {data.pages > 1 && (
        <nav className="pagination" aria-label="Pagine dei risultati">
          {data.page > 1 ? (
            <Link
              href={catalogHref(data.filters, data.page - 1)}
              className="button secondary"
            >
              Precedente
            </Link>
          ) : (
            <span />
          )}
          <span>
            Pagina {data.page} di {data.pages}
          </span>
          {data.page < data.pages ? (
            <Link
              href={catalogHref(data.filters, data.page + 1)}
              className="button secondary"
            >
              Successiva
            </Link>
          ) : (
            <span />
          )}
        </nav>
      )}
    </Shell>
  );
}
