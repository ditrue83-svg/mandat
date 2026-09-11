import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Sparkles } from "lucide-react";
import { pageViewer } from "@/lib/viewer";
import { getOpportunity } from "@/lib/queries";
import {
  formatDate,
  formatDeadline,
  formatMoney,
  sectorLabel,
} from "@/lib/domain";
import { Shell } from "@/components/shell";
import { DetailActions } from "@/components/detail-actions";
export const dynamic = "force-dynamic";
export default async function Detail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await pageViewer();
  const item = await getOpportunity(viewer, (await params).id);
  if (!item) notFound();
  return (
    <Shell viewer={viewer}>
      <Link href="/" className="back-link">
        <ArrowLeft size={16} /> Torna al Radar
      </Link>
      <section className="detail-heading">
        <div className="eyebrow">
          {item.sectors.map(sectorLabel).join(" · ") ||
            "OPPORTUNITÀ PUBBLICATA"}
        </div>
        <h1>{item.title}</h1>
        <p className="meta">
          {item.buyer} · {item.location}
        </p>
      </section>
      {viewer.demo && (
        <div className="notice">
          Questo è un bando inventato per esplorare Mandat. Non corrisponde a
          una gara reale.
        </div>
      )}
      {item.status !== "open" && (
        <div role="alert" className="notice error">
          Questo bando risulta{" "}
          {item.status === "cancelled"
            ? "annullato"
            : item.status === "awarded"
              ? "aggiudicato"
              : "chiuso"}
          . Controlla la pubblicazione originale.
        </div>
      )}
      <div className="detail-grid space-top">
        <div>
          <section className="panel">
            <h2>Le informazioni essenziali</h2>
            <dl className="detail-facts">
              <div>
                <dt>Scadenza</dt>
                <dd>{formatDeadline(item.deadline)}</dd>
              </div>
              <div>
                <dt>Importo stimato</dt>
                <dd>{formatMoney(item.valueChf)}</dd>
              </div>
              <div>
                <dt>Luogo di esecuzione</dt>
                <dd>{item.location || "Non indicato"}</dd>
              </div>
              <div>
                <dt>Procedura</dt>
                <dd>{item.procedure || "Non indicata"}</dd>
              </div>
              <div>
                <dt>Pubblicazione</dt>
                <dd>{formatDate(item.publishedAt)}</dd>
              </div>
              <div>
                <dt>Fonte</dt>
                <dd>
                  {item.source === "simap" ? "simap.ch" : "Foglio Ufficiale TI"}
                </dd>
              </div>
            </dl>
            {!viewer.demo && (
              <a
                className="source-link"
                href={item.sourceUrl}
                target="_blank"
                rel="noreferrer"
              >
                Verifica le informazioni originali <ArrowUpRight size={15} />
              </a>
            )}
          </section>
          <section className="panel">
            <div className="eyebrow">
              RIASSUNTO ASSISTITO DALL’AI · DA VERIFICARE
            </div>
            <h2>Di che lavoro si tratta?</h2>
            <p>
              {item.summary ||
                "Il riassunto non è ancora disponibile. Puoi leggere la pubblicazione originale qui sotto."}
            </p>
            <div className="match-note">
              <Sparkles size={16} />
              {item.reason}
            </div>
            {item.requirements.length > 0 && (
              <>
                <h3>Da controllare prima di partecipare</h3>
                <ul className="detail-list">
                  {item.requirements.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {item.reviewRequired && (
              <div className="notice">
                Alcune informazioni richiedono un controllo:{" "}
                {item.reviewReasons.join("; ")}. La fonte originale prevale.
              </div>
            )}
            {item.evidence.length > 0 && (
              <details className="space-top">
                <summary>Fonti delle informazioni estratte</summary>
                <ul className="detail-list">
                  {item.evidence.map((e, i) => (
                    <li key={i}>
                      <a
                        className="source-link"
                        href={e.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {e.field}
                        {e.page ? ` · pagina ${e.page}` : ""}
                      </a>
                      <br />“{e.quote}”
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
          <section className="panel">
            <h2>Pubblicazione originale</h2>
            {!viewer.demo && item.sourceUrls.length > 1 && (
              <p>
                Questa opportunità compare in {item.sourceUrls.length}{" "}
                pubblicazioni.{" "}
                {item.sourceUrls.map((url, i) => (
                  <a
                    key={url}
                    className="source-link"
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {i ? " · " : ""}Fonte {i + 1}
                  </a>
                ))}
              </p>
            )}
            <p className="original-text">{item.originalText}</p>
            {!viewer.demo && (
              <div className="space-top">
                <a
                  className="button secondary"
                  target="_blank"
                  rel="noreferrer"
                  href={item.sourceUrl}
                >
                  Apri la fonte ufficiale <ArrowUpRight size={16} />
                </a>
              </div>
            )}
            {item.documents.map((d, i) => (
              <p key={i}>
                <a
                  className="source-link"
                  target="_blank"
                  rel="noreferrer"
                  href={d.url}
                >
                  {d.title}{" "}
                  {d.requiresLogin ? "· Accesso sul portale originale" : ""}
                </a>
              </p>
            ))}
          </section>
        </div>
        <aside>
          <section className="panel">
            <DetailActions item={item} demo={viewer.demo} />
          </section>
          <section className="panel">
            <h3>Prima di fare il prossimo passo</h3>
            <p>
              La pertinenza non conferma che la ditta possieda tutti i
              requisiti. Verifica i documenti, le condizioni e le modalità di
              consegna sul portale originale.
            </p>
            <p>
              La partecipazione e l’invio dell’offerta restano a cura della tua
              ditta.
            </p>
          </section>
        </aside>
      </div>
    </Shell>
  );
}
