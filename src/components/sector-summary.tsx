import type { Sector } from "@/lib/sectors";
import { sectorCaption } from "@/lib/sectors";
import type {
  PublicationClassification,
  ProcurementKind,
  ClassificationReason,
} from "@/lib/sector-classification";
const kinds: Record<ProcurementKind, string> = {
  works: "Esecuzione di lavori",
  design: "Progettazione e consulenza tecnica",
  supply: "Fornitura di prodotti",
  installation: "Installazione",
  maintenance: "Manutenzione",
  service: "Prestazione di servizi",
};
const reasons: Record<ClassificationReason, string> = {
  insufficient_information:
    "L’oggetto disponibile non consente di assegnare un settore.",
  unsupported_cpv:
    "Il codice disponibile non permette un abbinamento affidabile ai settori di Mandat.",
  conflicting_information:
    "Il testo e la classificazione dichiarata nella fonte richiedono una verifica.",
  source_unavailable:
    "La versione corrente della fonte non è disponibile per la classificazione.",
};
export function SectorSummary({
  sectors,
  classification,
}: {
  sectors: Sector[];
  classification?: PublicationClassification;
}) {
  return (
    <details className="panel sector-summary">
      <summary>Settori e tipo di prestazione</summary>
      <p>{sectorCaption(sectors, classification?.needsClassification)}</p>
      {!!classification?.kinds.length && (
        <p className="meta">
          {classification.kinds.map((kind) => kinds[kind]).join(" · ")}
        </p>
      )}
      {classification?.reasons.map((reason) => (
        <p className="meta" key={reason}>
          {reasons[reason]}
        </p>
      ))}
      {!!classification?.lots.length && (
        <ul>
          {classification.lots.map((lot) => (
            <li key={lot.id}>
              <strong>Lotto {lot.number ?? "senza numero"}:</strong>{" "}
              {sectorCaption(lot.sectors, lot.needsClassification)}
              {lot.kinds.length > 0 && (
                <span className="meta">
                  {" "}
                  · {lot.kinds.map((kind) => kinds[kind]).join(" · ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="meta">
        I settori descrivono l’oggetto del bando. La pertinenza per la tua ditta
        e i requisiti di partecipazione richiedono una valutazione separata.
      </p>
    </details>
  );
}
