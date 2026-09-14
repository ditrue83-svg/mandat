import {
  findTitleCodeDifferences,
  type SourceTitleTranslation,
  type TitleCodeEvidence,
} from "@/lib/source-title-differences";

const languages = {
  it: "Italiano",
  de: "Tedesco",
  fr: "Francese",
  en: "Inglese",
};
function ComparedTitle({ evidence }: { evidence: TitleCodeEvidence }) {
  return (
    <div>
      <p className="meta">{languages[evidence.language]}</p>
      <blockquote className="original-text" lang={evidence.language}>
        {evidence.text.slice(0, evidence.start)}
        <mark>{evidence.text.slice(evidence.start, evidence.end)}</mark>
        {evidence.text.slice(evidence.end)}
      </blockquote>
      <details>
        <summary>Riferimento nell’originale</summary>
        <code>{evidence.path}</code>
      </details>
    </div>
  );
}

export function SourceTitleNotices({
  titles,
}: {
  titles: readonly SourceTitleTranslation[];
}) {
  const differences = findTitleCodeDifferences(titles);
  if (!differences.length) return null;
  return (
    <section
      className="notice source-title-notice"
      aria-label="Codici dei titoli da confrontare"
    >
      <h3>Codici diversi nei titoli originali</h3>
      <p>
        Alcune traduzioni dello stesso titolo riportano codici di lavoro
        diversi. Confronta i titoli con le descrizioni e i documenti prima di
        registrare il giudizio sulla fonte. Questa segnalazione non stabilisce
        quale versione sia corretta.
      </p>
      {differences.map(({ first, second }) => (
        <div
          className="space-top source-title-pair"
          key={`${first.group}:${first.path}:${second.path}`}
        >
          <ComparedTitle evidence={first} />
          <ComparedTitle evidence={second} />
        </div>
      ))}
    </section>
  );
}
