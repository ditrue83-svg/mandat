import Link from "next/link";
import { Search } from "lucide-react";
import { CatalogFilters as CatalogFilterBar } from "./catalog-filters";
import { Shell } from "@/components/shell";
import { BandiNavigation } from "@/components/bandi-navigation";
import { TenderListCard } from "@/components/tender-list-card";
import {
  catalogHref,
  catalogDetailHref,
  CATALOG_STATUS_LABELS,
  type CatalogSourceSummary,
} from "@/lib/catalog";
import { formatDeadline, type Viewer } from "@/lib/domain";
import type { readCatalog } from "@/lib/catalog";
import { sectorCaption } from "@/lib/sectors";
import { CatalogBookmark } from "@/components/catalog-bookmark";
import { tenderWorkExcerpt } from "@/lib/tender-brief";

function sourceHeadline(source: CatalogSourceSummary) {
  if (source.state === "disabled") return "non attivo nella beta";
  if (source.state === "error") return "problema nell’ultimo aggiornamento";
  if (source.state === "delayed") return "aggiornamento in ritardo";
  if (source.state === "unavailable") return "prima raccolta non disponibile";
  if (source.state === "updating") return "aggiornamento in corso";
  if (source.state === "demo") return "dati dimostrativi";
  return "aggiornata";
}

export function CatalogView({
  viewer,
  data,
}: {
  viewer: Viewer;
  data: Awaited<ReturnType<typeof readCatalog>>;
}) {
  const hasCustomFilters =
    !!data.filters.q ||
    data.filters.settore !== "all" ||
    data.filters.stato !== "open" ||
    data.filters.ordine !== "recenti";
  return (
    <Shell viewer={viewer}>
      <BandiNavigation active="catalog" />
      <section
        className="catalog-panel"
        aria-label="Ricerca tra tutti i bandi raccolti"
      >
        <CatalogFilterBar
          key={JSON.stringify(data.filters)}
          filters={data.filters}
          statuses={CATALOG_STATUS_LABELS}
        />
      </section>
      <section
        className={`source-summary-line${data.sourceDelayed ? " has-problem" : ""}`}
        role={data.sourceDelayed ? "alert" : "status"}
        aria-label="Stato delle fonti"
      >
        <div>
          <strong>Ticino ·</strong>{" "}
          {data.sources
            .filter((source) => source.included)
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
            {data.collectedCount} pubblicazioni nella raccolta ·{" "}
            {data.openCount} in corso. La raccolta è dedicata al Ticino e non
            rappresenta tutti gli appalti svizzeri.
          </p>
          <p>Sono mostrati inizialmente i bandi in corso.</p>
          <p>
            Consultare o salvare un bando non lo approva e non lo inserisce nel
            Radar. La pubblicazione ufficiale prevale sempre.
          </p>
        </details>
      </section>
      <div className="catalog-results-heading" role="status">
        <p>
          <strong>{data.total}</strong>{" "}
          {data.total === 1 ? "bando trovato" : "bandi trovati"}
        </p>
      </div>
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
              deadline={publication.deadline}
              status={CATALOG_STATUS_LABELS[publication.status]}
              statusTone={publication.status === "open" ? "good" : "neutral"}
              sector={sectorCaption(
                publication.sectors,
                publication.needsSectorClassification,
              )}
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
