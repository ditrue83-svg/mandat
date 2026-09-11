import { pageViewer } from "@/lib/viewer";
import { Shell } from "@/components/shell";
export const dynamic = "force-dynamic";
export default async function Sources() {
  const v = await pageViewer();
  return (
    <Shell viewer={v}>
      <div className="content-narrow">
        <section className="page-heading">
          <div>
            <div className="eyebrow">
              SAPERE DA DOVE ARRIVANO LE INFORMAZIONI
            </div>
            <h1>Fonti e copertura del Radar.</h1>
            <p>
              Mandat raccoglie opportunità pubblicate e ti aiuta a leggerle.
            </p>
          </div>
        </section>
        <section className="panel">
          <h2>simap.ch</h2>
          <p>
            La piattaforma svizzera degli appalti pubblici. Il Radar utilizza le
            informazioni pubbliche e rimanda ai capitolati sul portale
            originale. Alcuni documenti richiedono un accesso personale.
          </p>
          <p>
            Le nuove pubblicazioni sono visibili in Mandat dalle 08:00 del
            giorno di pubblicazione, ora svizzera.
          </p>
          <a
            href="https://www.simap.ch/it/about/legal"
            className="source-link"
            target="_blank"
            rel="noreferrer"
          >
            Condizioni e informazioni ufficiali
          </a>
        </section>
        <section className="panel">
          <h2>Foglio Ufficiale del Ticino</h2>
          <p>
            Le pubblicazioni cantonali sono accessibili tramite Amtsblattportal.
            Il PDF firmato costituisce la versione ufficiale.
          </p>
          <div className="notice">
            {process.env.FOGLIO_REUSE_CONFIRMED === "true" && !v.demo
              ? "Copertura attivata per le rubriche dei concorsi pubblici verificate."
              : "Fonte non ancora attivata per i clienti: verifica del riutilizzo e delle rubriche in corso."}
          </div>
          <a
            href="https://www.foglioufficiale.ti.ch"
            className="source-link"
            target="_blank"
            rel="noreferrer"
          >
            Apri il Foglio Ufficiale
          </a>
        </section>
        <section className="panel">
          <h2>Cosa significa “copertura”</h2>
          <p>
            Il Radar può trovare le opportunità effettivamente pubblicate nelle
            fonti collegate. Gli incarichi diretti senza bando e gli inviti
            riservati possono non essere visibili. In questa beta i portali
            comunali aggiuntivi non sono collegati.
          </p>
          <p>
            Un riassunto AI è un aiuto alla lettura e può contenere errori. La
            pubblicazione originale prevale sempre. Mandat non garantisce
            l’idoneità alla gara o l’aggiudicazione.
          </p>
        </section>
      </div>
    </Shell>
  );
}
