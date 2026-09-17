import Link from "next/link";
import { Search } from "lucide-react";
import { Shell } from "@/components/shell";
import { BandiNavigation } from "@/components/bandi-navigation";
import { TenderListCard } from "@/components/tender-list-card";
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
import { tenderWorkExcerpt } from "@/lib/tender-brief";

export const dynamic = "force-dynamic";

function sourceHeadline(source: CatalogSourceSummary) {
  if (source.state === "disabled") return "non attivo nella beta";
  if (source.state === "error") return "problema nell’ultimo aggiornamento";
  if (source.state === "delayed") return "aggiornamento in ritardo";
  if (source.state === "unavailable") return "prima raccolta non disponibile";
  if (source.state === "updating") return "aggiornamento in corso";
  if (source.state === "demo") return "dati dimostrativi";
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
  const hasCustomFilters =
    !!data.filters.q ||
    data.filters.settore !== "all" ||
    data.filters.stato !== "open" ||
    data.filters.ordine !== "recenti";
  return (
    <Shell viewer={viewer}>
      <BandiNavigation active="catalog" />
      <section
        className="panel catalog-panel"
        aria-label="Ricerca tra tutti i bandi raccolti"
      >
        <form action="/esplora" className="catalog-filters">
          <label className="catalog-search">
            <span className="sr-only">Cerca tra tutti i bandi raccolti</span>
            <span className="search-input">
              <Search size={18} aria-hidden="true" />
              <input
                name="q"
                defaultValue={data.filters.q}
                key={data.filters.q}
                placeholder="Cerca tra tutti i bandi raccolti…"
                maxLength={200}
              />
            </span>
          </label>
          <label>
            Settore
            <select
              name="settore"
              defaultValue={data.filters.settore}
              key={data.filters.settore}
            >
              <option value="all">Tutti i settori</option>
              {SECTORS.map((sector) => (
                <option key={sector.id} value={sector.id}>
                  {sector.label}
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
            <Search size={17} aria-hidden="true" /> Cerca
          </button>
        </form>
        <div className="catalog-results-heading">
          <p>
            <strong>{data.total}</strong>{" "}
            {data.total === 1 ? "risultato" : "risultati"} ·{" "}
            {data.collectedCount} nella raccolta · {data.openCount} in corso
          </p>
          {hasCustomFilters && (
            <Link href="/esplora" className="text-link">
              Azzera i filtri
            </Link>
          )}
        </div>
        <p className="catalog-scope-note">
          Sono mostrati inizialmente i bandi in corso. La raccolta è dedicata al
          Ticino e non rappresenta tutti gli appalti svizzeri.
        </p>
      </section>
      {!viewer.demo && (
        <section
          className={`source-summary-line${data.sourceDelayed ? " has-problem" : ""}`}
          role={data.sourceDelayed ? "alert" : "status"}
          aria-label="Stato delle fonti"
        >
          <div>
            <strong>Fonti:</strong>{" "}
            {data.sources
              .map((source) => `${source.label} ${sourceHeadline(source)}`)
              .join(" · ")}
          </div>
          <details>
            <summary>Copertura e ultimo aggiornamento</summary>
            <div className="source-status-list">
              {data.sources.map((source) => {
                const problem =
                  source.included &&
                  ["error", "delayed", "unavailable"].includes(source.state);
                return (
                  <div
                    className={`source-status ${source.state}`}
                    key={source.id}
                  >
                    <strong>
                      {source.label}: {sourceHeadline(source)}.
                    </strong>
                    <span>
                      {source.state === "disabled"
                        ? " Non incluso finché non sarà confermato il riutilizzo dei contenuti."
                        : source.lastSuccessAt
                          ? ` Ultima raccolta completata: ${formatDeadline(source.lastSuccessAt)}.`
                          : " Nessuna raccolta completata disponibile."}
                      {problem
                        ? " I dati presenti restano consultabili, ma potrebbero mancare aggiornamenti. Mandat riproverà automaticamente."
                        : ""}
                    </span>
                  </div>
                );
              })}
            </div>
            <p>
              Consultare o salvare un bando non lo approva e non lo inserisce
              nel Radar. La pubblicazione ufficiale prevale sempre.
            </p>
          </details>
        </section>
      )}
      <section
        className="tender-list catalog-list"
        aria-label="Risultati della ricerca"
      >
        {data.items.map((publication) => {
          const detailHref = catalogDetailHref(
            publication.id,
            data.filters,
            data.page,
          );
          return (
            <TenderListCard
              key={publication.id}
              title={publication.title}
              description={tenderWorkExcerpt(publication)}
              buyer={publication.buyer}
              location={publication.location}
              deadline={
                publication.deadline
                  ? `Scadenza ${formatDate(publication.deadline)}`
                  : "Scadenza non indicata"
              }
              status={CATALOG_STATUS_LABELS[publication.status]}
              statusTone={publication.status === "open" ? "good" : "neutral"}
              sector={
                publication.sectors.map(sectorLabel).join(" · ") ||
                "Settore da verificare"
              }
              detailHref={detailHref}
              saveAction={
                <CatalogBookmark
                  id={publication.id}
                  title={publication.title}
                  initialSaved={publication.saved}
                  demo={viewer.demo}
                />
              }
            />
          );
        })}
      </section>
      {!data.items.length && (
        <section className="empty-state panel">
          <Search size={32} aria-hidden="true" />
          <h2>
            {data.collectedCount === 0
              ? "Nessun bando è ancora disponibile nella raccolta."
              : "Nessun risultato corrisponde ai filtri."}
          </h2>
          <p>
            {data.collectedCount === 0
              ? "Controlla lo stato delle fonti: un errore di raccolta viene segnalato separatamente."
              : data.filters.stato === "open" && !hasCustomFilters
                ? "Non risultano bandi in corso. Puoi consultare anche gli altri stati."
                : "Prova meno parole oppure azzera settore, stato e ordinamento."}
          </p>
          <Link
            href={
              data.filters.stato === "open" && !hasCustomFilters
                ? "/esplora?stato=all"
                : "/esplora"
            }
            className="button primary"
          >
            {data.filters.stato === "open" && !hasCustomFilters
              ? "Mostra tutti gli stati"
              : "Azzera i filtri"}
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
