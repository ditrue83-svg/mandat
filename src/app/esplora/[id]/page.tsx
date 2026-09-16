import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, FileText } from "lucide-react";
import { Shell } from "@/components/shell";
import { pageViewer } from "@/lib/viewer";
import {
  readCatalogEntry,
  catalogReturnHref,
  CATALOG_STATUS_LABELS,
} from "@/lib/catalog";
import { CatalogBookmark } from "@/components/catalog-bookmark";
import {
  formatDate,
  formatDeadline,
  formatMoney,
  sectorLabel,
} from "@/lib/domain";

export const dynamic = "force-dynamic";
export default async function CatalogDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const viewer = await pageViewer();
  const { id } = await params;
  const rawReturn = (await searchParams).ritorno;
  const returnHref = catalogReturnHref(
    typeof rawReturn === "string" ? rawReturn : undefined,
  );
  const item = await readCatalogEntry(viewer, id);
  if (!item) notFound();
  return (
    <Shell viewer={viewer}>
      <Link href={returnHref} className="back-link">
        <ArrowLeft size={17} /> Esplora bandi
      </Link>
      <section className="page-heading">
        <div>
          <div className="eyebrow">
            PUBBLICAZIONE NON UFFICIALE ·{" "}
            {item.source === "simap" ? "SIMAP" : "FOGLIO TI"}
          </div>
          <h1>{item.title}</h1>
          <p>{item.buyer || "Ente non indicato"}</p>
        </div>
      </section>
      <div className="catalog-notice">
        <strong>
          {item.status === "open"
            ? "Pertinenza per la tua ditta da valutare"
            : CATALOG_STATUS_LABELS[item.status]}
        </strong>
        <p>
          {item.status === "open"
            ? "La consultazione non attesta l’idoneità a partecipare. Le proposte pertinenti entrano nel Radar dopo la valutazione prevista dalla beta."
            : "Questa pubblicazione è consultabile come storico e non è presentata come opportunità aperta."}
        </p>
      </div>
      <div className="detail-grid">
        <div>
          <section className="panel">
            <h2>Informazioni dalla pubblicazione</h2>
            <dl className="catalog-details">
              <div>
                <dt>Luogo</dt>
                <dd>{item.location || "Non indicato"}</dd>
              </div>
              <div>
                <dt>Pubblicazione</dt>
                <dd>{formatDate(item.publishedAt)}</dd>
              </div>
              <div>
                <dt>Scadenza</dt>
                <dd>{formatDeadline(item.deadline)}</dd>
              </div>
              <div>
                <dt>Importo</dt>
                <dd>{formatMoney(item.valueChf)}</dd>
              </div>
              <div>
                <dt>Stato</dt>
                <dd>{CATALOG_STATUS_LABELS[item.status]}</dd>
              </div>
              <div>
                <dt>Settori indicativi</dt>
                <dd>
                  {item.sectors.map(sectorLabel).join(", ") || "Non indicati"}
                </dd>
              </div>
            </dl>
          </section>
          <section className="panel">
            <h2>Testo della pubblicazione</h2>
            <p className="meta">
              Testo originale disponibile, nella lingua della fonte. Le
              condizioni ufficiali e le rettifiche prevalgono.
            </p>
            <div className="catalog-original">
              {item.originalText ||
                "Il testo non è disponibile. Consulta il portale originale."}
            </div>
          </section>
        </div>
        <aside>
          <section className="panel">
            <h2>Tienilo d’occhio</h2>
            <p>
              Salvalo anche se la pertinenza per la tua ditta non è stata ancora
              valutata.
            </p>
            <CatalogBookmark
              id={item.id}
              title={item.title}
              initialSaved={item.saved}
              demo={viewer.demo}
              wide
            />
          </section>
          <section className="panel">
            <h2>Consulta la fonte</h2>
            <p>
              Controlla la scadenza, i requisiti e tutti i documenti prima di
              preparare un’offerta.
            </p>
            {item.sourceUrl && (
              <a
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="button primary catalog-source"
              >
                Apri la fonte ufficiale <ArrowUpRight size={17} />
              </a>
            )}
            {item.documents.map((doc, index) => (
              <a
                className="document-link"
                key={`${doc.url}-${index}`}
                href={doc.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <FileText size={18} />
                <span>
                  {doc.title || "Documento"}
                  <small>
                    {doc.requiresLogin
                      ? "Accesso sul portale richiesto"
                      : "Documento pubblico"}
                  </small>
                </span>
                <ArrowUpRight size={15} />
              </a>
            ))}
          </section>
        </aside>
      </div>
    </Shell>
  );
}
