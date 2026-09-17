import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
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
import { MatchNote } from "@/components/match-note";
import {
  TenderBriefPanels,
  TenderSourceButton,
} from "@/components/tender-brief";
import { buildTenderBrief } from "@/lib/tender-brief";
import { publicLink } from "@/lib/tender-source-link";
import { plainText } from "@/sources/common";

export const dynamic = "force-dynamic";
export default async function Detail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await pageViewer();
  const item = await getOpportunity(viewer, (await params).id);
  if (!item) notFound();
  const brief = item.tenderBrief ?? buildTenderBrief(item);
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
        <TenderSourceButton publication={item} demo={viewer.demo} />
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
      {item.status === "open" &&
        item.deadline &&
        Date.parse(item.deadline) <= Date.now() && (
          <div role="alert" className="notice error">
            Il termine indicato è scaduto. Controlla eventuali proroghe nella
            fonte ufficiale prima di procedere.
          </div>
        )}
      <div className="detail-grid space-top">
        <div>
          <section className="panel">
            <h2>Le informazioni essenziali</h2>
            {item.lotReview && (
              <p className="meta">
                {item.lotReview.shape === "lots"
                  ? "Scadenza, importo e luogo devono essere verificati per ciascun lotto nella fonte ufficiale."
                  : "Verifica scadenza, importo e luogo del progetto nella fonte ufficiale."}
              </p>
            )}
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
          </section>
          <TenderBriefPanels
            brief={brief}
            relevance={
              <>
                <MatchNote assessment={item.assessment} reason={item.reason} />
                <p className="meta">
                  Il confronto riguarda l’interesse potenziale per la tua ditta.
                  Il possesso dei requisiti e l’idoneità a partecipare vanno
                  verificati nei documenti ufficiali.
                </p>
                {item.lotReview?.shape === "unresolved" && (
                  <p className="notice">
                    La struttura della gara non è verificata. La fonte richiede
                    una verifica prima di valutare la pertinenza.
                  </p>
                )}
                {item.lotReview?.targets.map((lot) => (
                  <details
                    className="brief-review"
                    key={
                      lot.target.kind === "project"
                        ? "project"
                        : lot.target.lotId
                    }
                  >
                    <summary>
                      {lot.target.kind === "project"
                        ? "Valutazione dell’intero progetto — gara senza lotti"
                        : lot.number === null
                          ? "Valutazione del lotto senza numero indicato"
                          : "Valutazione del lotto " + lot.number}
                    </summary>
                    <p>
                      {lot.state === "current"
                        ? lot.result === "direct"
                          ? "Interesse potenziale verificato"
                          : lot.result === "different"
                            ? "Attività diverse da quelle della ditta"
                            : "Pertinenza da verificare"
                        : "Valutazione da aggiornare"}
                    </p>
                    {lot.reason && <p>{lot.reason}</p>}
                    {lot.issue && (
                      <p className="notice">
                        {lot.issue === "assessment_missing"
                          ? "La valutazione per questa ditta non è ancora disponibile."
                          : lot.issue === "stale_profile"
                            ? "Il profilo della ditta è cambiato: la valutazione deve essere aggiornata."
                            : "La valutazione richiede un controllo dei dati correnti della fonte e della ditta."}
                      </p>
                    )}
                    <p className="meta">
                      Luogo: {lot.operational?.location || "Non indicato"} ·
                      Scadenza:{" "}
                      {formatDeadline(lot.operational?.deadline ?? null)} ·
                      Importo: {formatMoney(lot.operational?.valueChf ?? null)}
                    </p>
                    {!!lot.reviewReasons.length && (
                      <p className="notice">{lot.reviewReasons.join("; ")}</p>
                    )}
                    {!!lot.evidence.length && (
                      <details>
                        <summary>
                          Passaggi della fonte usati nella revisione
                        </summary>
                        {lot.evidence.map((e, i) => (
                          <blockquote key={i}>
                            {plainText(e.quote)}{" "}
                            {publicLink(e.url) && (
                              <a
                                className="source-link"
                                href={publicLink(e.url)}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                Fonte ufficiale
                                {e.page ? " · pagina " + e.page : ""}
                              </a>
                            )}
                          </blockquote>
                        ))}
                      </details>
                    )}
                  </details>
                ))}
                {item.reviewRequired && !!item.reviewReasons.length && (
                  <div className="notice">
                    Informazioni da controllare: {item.reviewReasons.join("; ")}
                    . La fonte originale prevale.
                  </div>
                )}
              </>
            }
          />
          <details className="panel original-publication">
            <summary>Testo integrale acquisito e fonti</summary>
            <p className="meta">
              Pubblicazione non ufficiale. Testo disponibile nella lingua della
              fonte.
            </p>
            <p className="original-text">{plainText(item.originalText)}</p>
            {!viewer.demo && item.sourceUrls.length > 1 && (
              <p>
                Questa opportunità compare in più pubblicazioni.{" "}
                {item.sourceUrls
                  .filter((url) => publicLink(url))
                  .map((url, i) => (
                    <a
                      key={url}
                      className="source-link"
                      href={publicLink(url)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {i ? " · " : ""}Fonte {i + 1}
                    </a>
                  ))}
              </p>
            )}
          </details>
        </div>
        <aside>
          <section className="panel">
            <DetailActions item={item} demo={viewer.demo} />
          </section>
          <section className="panel">
            <h3>Prima di partecipare</h3>
            <p>
              Controlla i documenti, le condizioni e le rettifiche nella
              pubblicazione ufficiale. La partecipazione e l’invio dell’offerta
              restano a cura della tua ditta.
            </p>
            <TenderSourceButton publication={item} demo={viewer.demo} />
          </section>
        </aside>
      </div>
    </Shell>
  );
}
