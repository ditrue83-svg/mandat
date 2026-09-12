import type { SourceCondition } from "@/lib/domain";

const labels = {
  "terms.subContractorAllowed": "Subappalto",
  "terms.subContractorNote": "Note sul subappalto",
  "procurement.partialOffers": "Offerte parziali",
  "procurement.partialOffersNote": "Note sulle offerte parziali",
} as const;
const languages = {
  it: "Italiano",
  de: "Tedesco",
  fr: "Francese",
  en: "Inglese",
} as const;

function description(condition: SourceCondition) {
  if (condition.value === null) return "Non indicato (valore nullo).";
  if (
    condition.path === "terms.subContractorAllowed" ||
    condition.path === "procurement.partialOffers"
  ) {
    const plural = condition.path === "procurement.partialOffers";
    if (condition.value === "yes") return plural ? "Ammesse." : "Ammesso.";
    if (condition.value === "no")
      return plural ? "Non ammesse." : "Non ammesso.";
    if (condition.value === "not_specified") return "Non specificato.";
    return "Valore non riconosciuto: da verificare nella fonte.";
  }
  if (typeof condition.value === "string")
    return condition.value.trim()
      ? "Testo originale."
      : "Testo vuoto nella fonte.";
  return "Valore strutturato o non riconosciuto: da verificare nella fonte.";
}

function originalValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function publicationUrl(value: string) {
  // These conditions come from a specific simap publication, never a project
  // overview or an arbitrary URL supplied inside a source note.
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  return new RegExp(
    `^https://www\\.simap\\.ch/api/publications/v1/project/${uuid}/publication-details/${uuid}$`,
    "i",
  ).test(value);
}

export function SourceConditions({
  conditions,
}: {
  conditions?: SourceCondition[];
}) {
  return (
    <section
      className="space-top"
      aria-label="Condizioni riportate dalla fonte"
    >
      <h4>Condizioni riportate dalla fonte</h4>
      {!conditions?.length ? (
        <p className="meta">Condizioni non disponibili nei dati acquisiti.</p>
      ) : (
        <>
          <p className="meta">
            Dati originali da controllare nella pubblicazione. Le note precisano
            le condizioni del bando.
          </p>
          <ul className="detail-list">
            {conditions.map((condition, index) => {
              const knownPath = Object.keys(labels).find(
                (path) =>
                  condition.path === path ||
                  condition.path.startsWith(`${path}.`),
              ) as keyof typeof labels | undefined;
              return (
                <li key={`${condition.path}:${index}`}>
                  <strong>
                    {knownPath ? labels[knownPath] : "Campo non riconosciuto"}
                  </strong>
                  {condition.language && (
                    <span className="meta">
                      {" "}
                      · {languages[condition.language]}
                    </span>
                  )}
                  <p>{description(condition)}</p>
                  <div className="meta">Valore originale</div>
                  <blockquote
                    className="original-text"
                    lang={condition.language}
                  >
                    {originalValue(condition.value)}
                  </blockquote>
                  <p className="meta">Campo della fonte: {condition.path}</p>
                  {publicationUrl(condition.url) ? (
                    <a
                      className="source-link"
                      href={condition.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Verifica nella pubblicazione originale
                    </a>
                  ) : (
                    <p className="meta">
                      Collegamento alla pubblicazione non disponibile.
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
