import type { ReactNode } from "react";
import {
  AlertTriangle,
  FileCheck2,
  MapPin,
  Send,
  Timer,
  Wrench,
} from "lucide-react";
import type { BriefFact, TenderBrief } from "@/lib/tender-brief";
import {
  publicLink,
  tenderSourceLabel,
  tenderSourceLink,
  tenderReferenceLink,
} from "@/lib/tender-source-link";
import type { Publication } from "@/lib/domain";

const languageNames: Record<string, string> = {
  it: "Italiano",
  fr: "Francese",
  de: "Tedesco",
  en: "Inglese",
};

export function TenderSourceButton({
  publication,
  demo = false,
  className = "button primary tender-source",
}: {
  publication: Pick<Publication, "source" | "sourceUrl"> & {
    externalId?: string;
  };
  demo?: boolean;
  className?: string;
}) {
  const href = tenderSourceLink(publication),
    label = tenderSourceLabel(publication.source);
  return href && !demo ? (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
    </a>
  ) : (
    <span
      className={`${className} disabled`}
      aria-disabled="true"
      title={demo ? "Bando dimostrativo" : "Collegamento non disponibile"}
    >
      {label}
    </span>
  );
}

function Fact({ fact }: { fact: BriefFact }) {
  const link = publicLink(fact.link),
    source = tenderReferenceLink(fact.source.url);
  return (
    <div className="brief-fact">
      <strong>{fact.label}</strong>
      {fact.language && fact.language !== "it" && (
        <span className="meta">
          {" "}
          · {languageNames[fact.language] ?? fact.language} · testo originale
        </span>
      )}
      <p className="brief-text" lang={fact.language}>
        {fact.text}
      </p>
      {link && (
        <a
          className="source-link"
          href={link}
          target="_blank"
          rel="noopener noreferrer"
        >
          {fact.label} ↗
        </a>
      )}
      {source && (
        <a
          className="brief-reference"
          href={source}
          target="_blank"
          rel="noopener noreferrer"
        >
          Fonte: {fact.label}
          {fact.source.page ? ` · pagina ${fact.source.page}` : ""} ↗
        </a>
      )}
    </div>
  );
}
export function BriefFacts({
  facts,
  empty,
}: {
  facts: BriefFact[];
  empty: string;
}) {
  if (!facts.length) return <p className="brief-missing">{empty}</p>;
  const primary: BriefFact[] = [],
    translations: BriefFact[] = [],
    seen = new Set<string>();
  for (const fact of facts) {
    const key = `${fact.label}:${fact.source.path.replace(/\/(it|de|fr|en)$/, "")}`;
    if (seen.has(key) && fact.language) translations.push(fact);
    else {
      seen.add(key);
      primary.push(fact);
    }
  }
  return (
    <>
      <div className="brief-facts">
        {primary.map((fact, i) => (
          <Fact key={`${fact.source.path}-${i}`} fact={fact} />
        ))}
      </div>
      {!!translations.length && (
        <details className="brief-translations">
          <summary>Altre lingue presenti nella fonte</summary>
          {translations.map((fact, i) => (
            <Fact key={`${fact.source.path}-${i}`} fact={fact} />
          ))}
        </details>
      )}
    </>
  );
}

function shortWork(text: string) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) return compact;
  const boundary = compact.lastIndexOf(" ", 179);
  return compact.slice(0, boundary > 100 ? boundary : 179).trim() + "…";
}

type ScopedFact = { fact: BriefFact; scope?: string };
function summaryFacts(brief: TenderBrief, field: "deadlines" | "visits") {
  return [
    ...brief[field].map((fact) => ({ fact }) as ScopedFact),
    ...brief.lots.flatMap((lot) =>
      lot[field].map((fact) => ({ fact, scope: `Lotto ${lot.number}` })),
    ),
  ].filter(
    (entry, index, all) =>
      all.findIndex(
        (other) =>
          other.scope === entry.scope &&
          other.fact.label === entry.fact.label &&
          other.fact.source.path.replace(/\/(it|de|fr|en)$/, "") ===
            entry.fact.source.path.replace(/\/(it|de|fr|en)$/, ""),
      ) === index,
  );
}
function SummaryFacts({
  entries,
  empty,
}: {
  entries: ScopedFact[];
  empty: string;
}) {
  if (!entries.length) return <span>{empty}</span>;
  return (
    <ul className="decision-facts">
      {entries.map(({ fact, scope }, index) => (
        <li key={index} lang={fact.language}>
          <strong>
            {scope ? `${scope} · ` : ""}
            {fact.label}
          </strong>
          <span>{fact.text}</span>
        </li>
      ))}
    </ul>
  );
}
function decisiveRequirement(facts: BriefFact[]) {
  return (
    facts.find((fact) =>
      /qualificationCriteriaNote|qualificationCriteria\/\d+|otherRequirements/.test(
        fact.source.path,
      ),
    ) ?? facts[0]
  );
}
export function TenderDecisionSummary({
  brief,
  location,
}: {
  brief: TenderBrief;
  location: string;
}) {
  const allDeadlines = summaryFacts(brief, "deadlines");
  const deadlines = allDeadlines.filter(({ fact }) =>
    /partecipazione|presentazione dell’offerta|fase successiva|manifestazione di interesse|procedura da verificare|termine indicato/.test(
      fact.label.toLocaleLowerCase("it"),
    ),
  );
  const questions = allDeadlines.filter(({ fact }) =>
    /^Domande di chiarimento/.test(fact.label),
  );
  const visits = summaryFacts(brief, "visits");
  const mandatoryVisit = visits.some(({ fact }) =>
    /obbligatori|mandatory|zwingend/.test(fact.text.toLocaleLowerCase("it")),
  );
  const requirements: ScopedFact[] = [];
  const projectRequirement = decisiveRequirement(brief.requirements);
  if (projectRequirement) requirements.push({ fact: projectRequirement });
  for (const lot of brief.lots) {
    const fact = decisiveRequirement(lot.requirements);
    if (fact) requirements.push({ fact, scope: `Lotto ${lot.number}` });
  }
  const submissions: ScopedFact[] = [];
  const submissionSummary = (facts: BriefFact[]) =>
    facts.find(
      (fact) =>
        fact.label === "Modalità e formalità di presentazione" &&
        fact.text.length <= 320,
    ) ??
    facts.find((fact) => fact.label === "Modalità di inoltro") ??
    facts.find((fact) => fact.label === "Istruzioni per la consegna") ??
    facts[0];
  const projectSubmission = submissionSummary(brief.submission);
  if (projectSubmission) submissions.push({ fact: projectSubmission });
  // A lot's instructions are never silently presented as project-wide rules.
  for (const lot of brief.lots) {
    const fact = submissionSummary(lot.submission);
    if (fact) submissions.push({ fact, scope: `Lotto ${lot.number}` });
  }
  return (
    <section
      className="panel decision-summary"
      aria-labelledby="decision-summary-title"
    >
      <div>
        <div className="eyebrow">PRIMA DI PARTECIPARE</div>
        <h2 id="decision-summary-title">Le condizioni decisive, in breve</h2>
      </div>
      {!!brief.lots.length && (
        <p className="decision-lot-notice">
          Gara con {brief.lots.length} lotti: controlla separatamente le
          condizioni di ciascuno.
        </p>
      )}
      <dl className="decision-grid">
        <div>
          <dt>
            <MapPin size={17} aria-hidden="true" /> Luogo
          </dt>
          <dd>{location || "Non indicato"}</dd>
        </div>
        <div>
          <dt>
            <Timer size={17} aria-hidden="true" /> Termini di partecipazione
          </dt>
          <dd>
            <SummaryFacts
              entries={deadlines}
              empty="Non indicati nei dati acquisiti: verifica la fase applicabile nella fonte."
            />
          </dd>
        </div>
        <div className={mandatoryVisit ? "decision-warning" : ""}>
          <dt>
            <AlertTriangle size={17} aria-hidden="true" /> Sopralluogo
          </dt>
          <dd>
            <SummaryFacts
              entries={visits}
              empty="Non indicato nei dati acquisiti: controlla il capitolato."
            />
          </dd>
        </div>
        <div>
          <dt>
            <Send size={17} aria-hidden="true" /> Modalità di consegna
          </dt>
          <dd>
            <SummaryFacts
              entries={submissions}
              empty="Modalità non indicata nei dati acquisiti: consulta le istruzioni ufficiali."
            />
            <a className="text-link" href="#brief-submit">
              Tutte le modalità e il recapito
            </a>
          </dd>
        </div>
        <div className="decision-requirement">
          <dt>
            <FileCheck2 size={17} aria-hidden="true" /> Requisito determinante
          </dt>
          <dd>
            <SummaryFacts
              entries={requirements}
              empty="Non indicato nei dati acquisiti: verifica criteri e documenti ufficiali."
            />
            <a className="text-link" href="#brief-requirements">
              Tutti i requisiti e i documenti
            </a>
          </dd>
        </div>
        {questions.length > 0 && (
          <div className="decision-questions">
            <dt>
              <Timer size={17} aria-hidden="true" /> Domande di chiarimento
            </dt>
            <dd>
              <SummaryFacts entries={questions} empty="Non indicate" />
            </dd>
          </div>
        )}
        <div className="decision-work">
          <dt>
            <Wrench size={17} aria-hidden="true" /> Il lavoro, in sintesi
          </dt>
          <dd>
            {shortWork(
              brief.description[0]?.text ||
                "Descrizione non disponibile nei dati acquisiti: consulta la fonte ufficiale.",
            )}
            <a className="text-link" href="#brief-work">
              Leggi la descrizione completa
            </a>
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function TenderBriefPanels({
  brief,
  relevance,
}: {
  brief: TenderBrief;
  relevance: ReactNode;
}) {
  return (
    <div className="tender-brief">
      {brief.warning && (
        <div className="notice error" role="alert">
          {brief.warning}
        </div>
      )}
      <section className="panel" aria-labelledby="brief-work">
        <div className="eyebrow">
          DALLA PUBBLICAZIONE ORIGINALE
          {brief.publicationNumber ? ` · ${brief.publicationNumber}` : ""}
        </div>
        <h2 id="brief-work">Il lavoro richiesto</h2>
        <BriefFacts
          facts={brief.description}
          empty="La descrizione del lavoro non è disponibile nei dati acquisiti. Consulta la pubblicazione originale."
        />
        {brief.lots.map((lot) => (
          <div className="brief-lot" key={lot.id}>
            <h3>Lotto {lot.number}</h3>
            <BriefFacts
              facts={lot.description}
              empty="Descrizione del lotto non indicata nei dati acquisiti."
            />
          </div>
        ))}
      </section>
      <section className="panel relevance-panel" aria-labelledby="brief-fit">
        <h2 id="brief-fit">Perché può interessare alla tua ditta</h2>
        {relevance}
      </section>
      <section className="panel" aria-labelledby="brief-requirements">
        <h2 id="brief-requirements">Requisiti e documenti</h2>
        <h3>Requisiti principali</h3>
        <BriefFacts
          facts={brief.requirements}
          empty="Requisiti non indicati nei dati acquisiti. Verifica criteri di idoneità e condizioni nel capitolato ufficiale."
        />
        <h3>Documenti di gara e prove richieste</h3>
        <BriefFacts
          facts={brief.documents}
          empty="Elenco dei documenti non disponibile. Verifica nella pubblicazione come ottenere il capitolato e quali allegati presentare."
        />
        <h3>Sopralluoghi</h3>
        <BriefFacts
          facts={brief.visits}
          empty="Obbligatorietà, date e modalità del sopralluogo non indicate nei dati acquisiti. Non significa che il sopralluogo non sia richiesto: controlla il capitolato."
        />
        {brief.lots.map((lot) => (
          <div className="brief-lot" key={lot.id}>
            <h3>Requisiti del lotto {lot.number}</h3>
            <BriefFacts
              facts={lot.requirements}
              empty="Requisiti specifici del lotto da verificare nei documenti."
            />
            {!!lot.documents.length && (
              <>
                <h4>Documenti e prove del lotto {lot.number}</h4>
                <BriefFacts
                  facts={lot.documents}
                  empty="Documenti del lotto non indicati."
                />
              </>
            )}
            <h4>Sopralluogo del lotto {lot.number}</h4>
            <BriefFacts
              facts={lot.visits}
              empty="Sopralluogo specifico del lotto non indicato. Verifica le condizioni generali e quelle del lotto."
            />
          </div>
        ))}
      </section>
      <section className="panel" aria-labelledby="brief-submit">
        <h2 id="brief-submit">Scadenze e modalità di partecipazione</h2>
        {!!brief.lots.length && (
          <p className="notice">
            Le indicazioni generali della pubblicazione non sostituiscono i
            termini e le modalità specifici di ciascun lotto.
          </p>
        )}
        <h3>Termini della pubblicazione</h3>
        <BriefFacts
          facts={brief.deadlines}
          empty="Termine di presentazione non indicato nei dati acquisiti. Verifica la fonte ufficiale."
        />
        <h3>Come presentare l’offerta</h3>
        <BriefFacts
          facts={brief.submission}
          empty="Modalità e recapito di presentazione non indicati nei dati acquisiti. Consulta le istruzioni ufficiali prima di inviare l’offerta."
        />
        {brief.lots.map((lot) => (
          <div className="brief-lot" key={lot.id}>
            <h3>Presentazione del lotto {lot.number}</h3>
            <BriefFacts
              facts={lot.deadlines}
              empty="Scadenza specifica del lotto non indicata nei dati acquisiti."
            />
            <BriefFacts
              facts={lot.submission}
              empty="Modalità specifiche del lotto da verificare nella fonte."
            />
          </div>
        ))}
        <p className="meta">
          Le ore indicate sono quelle svizzere. Le date prive di orario
          rimangono esplicitamente senza orario. La pubblicazione ufficiale e le
          sue rettifiche prevalgono.
        </p>
      </section>
    </div>
  );
}
