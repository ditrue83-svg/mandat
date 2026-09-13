"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { OriginalText } from "./lot-source-editor";
import type { LotMatchEditorData } from "@/lib/lot-match-editor-data";
import type { LotDocumentaryReference } from "@/lib/lot-source-context";
import type { LotAssessmentResult } from "@/lib/lot-assessment";

const results: Record<LotAssessmentResult, string> = {
  direct: "Potenzialmente pertinente",
  different: "Attività diversa da quella della ditta",
  review: "Da approfondire",
};
type Submission = {
  data: LotMatchEditorData;
  action: "assess_lot" | "assess_project" | "veto_project" | "reopen_project";
  result: LotAssessmentResult | "";
  reason: string;
  note: string;
  references: LotDocumentaryReference[];
  confirmedReviewReasons: string[];
  confirmedProjectAction: boolean;
};
const invalid = (message: string) => ({ ok: false, stale: false, message });
export async function submitLotMatchReview(input: Submission) {
  const { data, action } = input;
  const note = input.note.trim();
  if (note.length < 10 || note.length > 800)
    return invalid("Scrivi una nota privata da 10 a 800 caratteri.");
  const common = {
    companyId: data.company.id,
    publicationId: data.publication.id,
    expectedSnapshotHash: data.expected.snapshotHash,
    expectedProfileHash: data.expected.profileHash,
    expectedStateToken: data.expected.stateToken,
    expectedGroupToken: data.expected.groupToken,
    expectedShapeEpochToken: data.expected.shapeEpochToken,
    note,
  };
  let body;
  if (action === "assess_lot" || action === "assess_project") {
    const selected = data.selected;
    const reason = input.reason.trim();
    if (!selected?.canAssess)
      return invalid(
        "La fonte selezionata non consente una valutazione verificabile.",
      );
    if ((action === "assess_project") !== (selected.target.kind === "project"))
      return invalid(
        "Il tipo di valutazione non corrisponde al contenuto selezionato.",
      );
    if (!input.result || reason.length < 10 || reason.length > 4000)
      return invalid(
        "Scegli il giudizio e scrivi un motivo visibile da 10 a 4000 caratteri.",
      );
    if (
      !input.references.length ||
      input.references.length > 128 ||
      input.references.some((ref) => {
        const text = selected.texts.find(
          (entry) => entry.path === ref.rawPath,
        )?.text;
        return (
          ref.selectionHash !==
            selected.expected.sourceDependency.selectionHash ||
          text === undefined ||
          !Number.isInteger(ref.startUtf16) ||
          !Number.isInteger(ref.endUtf16) ||
          ref.startUtf16 < 0 ||
          ref.endUtf16 <= ref.startUtf16 ||
          ref.endUtf16 > text.length ||
          ref.endUtf16 - ref.startUtf16 > 18000
        );
      })
    )
      return invalid(
        "Seleziona almeno un passaggio valido del contenuto originale corrente.",
      );
    if (
      input.result !== "review" &&
      (!selected.allowsCertainty ||
        !input.references.some((ref) =>
          selected.texts.some(
            (entry) =>
              entry.path === ref.rawPath &&
              entry.documentary &&
              entry.scope ===
                (selected.target.kind === "project" ? "project" : "lot"),
          ),
        ))
    )
      return invalid(
        "Un giudizio conclusivo richiede la fonte verificata e una citazione della prestazione selezionata.",
      );
    if (input.result === "direct" && !selected.eligible)
      return invalid(
        "Il giudizio positivo non può superare un’esclusione operativa.",
      );
    if (
      input.result === "direct" &&
      (input.confirmedReviewReasons.length !== selected.reviewReasons.length ||
        selected.reviewReasons.some(
          (reason) => !input.confirmedReviewReasons.includes(reason),
        ))
    )
      return invalid(
        "Verifica e conferma ogni punto indicato prima del giudizio positivo.",
      );
    body = {
      ...common,
      action,
      target: selected.target,
      expectedSourceDependency: selected.expected.sourceDependency,
      expectedOperationalInputHash: selected.expected.operationalInputHash,
      expectedEvaluationSetToken: selected.expected.evaluationSetToken,
      expectedEntryHash: selected.expected.entryHash,
      result: input.result,
      reason,
      references: input.references.map((ref) => ({
        selectionHash: ref.selectionHash,
        rawPath: ref.rawPath,
        startUtf16: ref.startUtf16,
        endUtf16: ref.endUtf16,
      })),
      // The exact server order is part of the operational confirmation contract.
      confirmedReviewReasons:
        input.result === "direct" ? [...selected.reviewReasons] : [],
    };
  } else {
    if (!input.confirmedProjectAction)
      return invalid("Conferma esplicitamente l’azione sull’intero progetto.");
    if (action === "reopen_project" && !data.project.suppressed)
      return invalid("Il progetto non ha un’esclusione da riconsiderare.");
    body = {
      ...common,
      action,
      expectedProjectBindingHash: data.expected.projectBindingHash,
    };
  }
  const response = await fetch("/api/admin/lot-match-reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 409)
    return {
      ok: false,
      stale: true,
      message:
        "Fonte, profilo o valutazione sono cambiati. Aggiorna la pagina prima di salvare.",
    };
  if (!response.ok)
    return invalid(
      "Valutazione non salvata. Controlla i dati e i riferimenti.",
    );
  return {
    ok: true,
    stale: false,
    message:
      action === "reopen_project"
        ? "Progetto riconsiderato. La pertinenza richiede ancora un giudizio corrente."
        : action === "veto_project"
          ? "Esclusione del progetto registrata."
          : action === "assess_project"
            ? "Valutazione dell’intero progetto salvata."
            : "Valutazione del lotto salvata.",
  };
}

export function LotMatchEditor({ data }: { data: LotMatchEditorData }) {
  const router = useRouter();
  const [references, setReferences] = useState<LotDocumentaryReference[]>([]);
  const [result, setResult] = useState<LotAssessmentResult | "">("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [confirmedReviewReasons, setConfirmedReviewReasons] = useState<
    string[]
  >([]);
  const [confirmedProjectAction, setConfirmedProjectAction] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const submitting = useRef(false);
  const selected = data.selected;
  const projectTarget = selected?.target.kind === "project";
  const path = `/admin/valutazioni/${encodeURIComponent(data.company.id)}/${encodeURIComponent(data.publication.id)}`;
  const sourcePath = `/admin/fonti/${encodeURIComponent(data.publication.id)}/lotti`;
  let sourceUrl: string | null = null;
  try {
    const url = new URL(data.publication.sourceUrl);
    if (url.protocol === "https:" && !url.username && !url.password)
      sourceUrl = url.href;
  } catch {
    /* Invalid original URLs are plain absent links. */
  }
  const add = (reference: LotDocumentaryReference) =>
    setReferences((current) =>
      current.length >= 128 ||
      current.some((ref) => JSON.stringify(ref) === JSON.stringify(reference))
        ? current
        : [...current, reference],
    );
  async function save(action: Submission["action"]) {
    if (submitting.current || stale) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const response = await submitLotMatchReview({
        data,
        action,
        result,
        reason,
        note,
        references,
        confirmedReviewReasons,
        confirmedProjectAction,
      });
      setMessage(response.message);
      setStale(response.stale);
      if (response.ok) {
        setStale(true);
        router.refresh();
      }
    } catch {
      setMessage(
        "Connessione interrotta: aggiorna la pagina per verificare se il salvataggio è riuscito.",
      );
      setStale(true);
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <p className="eyebrow">Valutazione umana della pertinenza</p>
      <h1>{data.publication.title}</h1>
      <h2>{data.company.profile.name}</h2>
      <p>
        {data.shape.kind === "project"
          ? "Questa gara non è suddivisa in lotti: il giudizio riguarda l’intero progetto."
          : "Una scheda per il progetto, con giudizi distinti per gli eventuali lotti."}{" "}
        La pertinenza descrive un interesse potenziale e non attesta l’idoneità
        a partecipare.
      </p>
      <details className="space-top" open>
        <summary>Profilo della ditta</summary>
        <p>{data.company.profile.activities}</p>
        <dl>
          <dt>Settori</dt>
          <dd>{data.company.profile.sectors.join(", ")}</dd>
          <dt>Zone servite</dt>
          <dd>{data.company.profile.zones.join(", ")}</dd>
          <dt>Addetti</dt>
          <dd>{data.company.profile.employees}</dd>
          <dt>Parole chiave</dt>
          <dd>{data.company.profile.keywords.join(", ") || "Nessuna"}</dd>
          <dt>Esclusioni</dt>
          <dd>{data.company.profile.exclusions.join(", ") || "Nessuna"}</dd>
          <dt>Fascia economica CHF</dt>
          <dd>
            {data.company.profile.minValue ?? "Non indicato"} –{" "}
            {data.company.profile.maxValue ?? "Non indicato"}
          </dd>
        </dl>
      </details>
      <nav className="lot-source-nav" aria-label="Progetto e lotti">
        <Link
          href={path}
          aria-current={!selected || projectTarget ? "page" : undefined}
        >
          {data.shape.kind === "project" ? "Intero progetto" : "Progetto"}
        </Link>
        {data.lots.map((lot) => (
          <Link
            key={lot.id}
            href={`${path}?lot=${encodeURIComponent(lot.id)}`}
            aria-current={
              selected?.target.kind === "lot" &&
              selected.target.lotId === lot.id
                ? "page"
                : undefined
            }
          >
            {lot.state === "removed-or-unresolved"
              ? "Lotto non più presente"
              : lot.number === null
                ? "Lotto senza numero indicato"
                : `Lotto ${lot.number}`}
          </Link>
        ))}
      </nav>
      <p>{data.project.reason}</p>
      {data.project.suppressed && (
        <p className="notice">
          L’esclusione del progetto resta attiva anche salvando un giudizio di
          pertinenza. Per ritirarla usa Riconsidera progetto.
        </p>
      )}
      {data.project.dismissed && (
        <p className="notice">
          La ditta ha scelto “Non interessa”. Riconsiderare l’esclusione del
          fondatore non cambia questa scelta.
        </p>
      )}
      {data.project.blocked && (
        <p className="notice">
          Il progetto richiede ancora una revisione della fonte.{" "}
          <Link href={sourcePath}>Esamina la fonte del progetto</Link>.
        </p>
      )}
      {data.shape.kind === "unresolved" && (
        <p className="notice">
          La struttura della gara è da verificare. Non è possibile approvare
          l’intero progetto o i lotti finché i dati sulla struttura non sono
          verificati.
        </p>
      )}
      {!selected && (
        <ul>
          {data.lots.map((lot) => (
            <li key={lot.id}>
              Lotto {lot.number ?? lot.id}:{" "}
              {lot.result
                ? results[lot.result]
                : lot.state === "stale"
                  ? "Giudizio precedente da aggiornare"
                  : "Valutazione da completare"}
              {lot.reason ? ` — ${lot.reason}` : ""}
            </li>
          ))}
        </ul>
      )}
      {selected && (
        <>
          <h2>
            {projectTarget
              ? "Intero progetto — gara senza lotti"
              : selected.number === null
                ? "Lotto non disponibile"
                : `Lotto ${selected.number}`}
          </h2>
          {!selected.canAssess && (
            <p className="notice">
              Il contenuto corrente selezionato non è utilizzabile. I giudizi
              precedenti restano nello storico.
            </p>
          )}
          {!selected.allowsCertainty && (
            <p className="notice">
              Per un giudizio conclusivo occorre prima verificare la fonte
              {projectTarget ? " del progetto" : " del lotto e del progetto"}.
              Puoi registrare “Da approfondire” con citazioni verificabili.{" "}
              <Link
                href={
                  selected.target.kind === "project"
                    ? sourcePath
                    : `${sourcePath}?lot=${encodeURIComponent(selected.target.lotId)}`
                }
              >
                {projectTarget
                  ? "Esamina la fonte del progetto"
                  : "Esamina la fonte del lotto"}
              </Link>
              .
            </p>
          )}
          <p className="notice">{selected.filterReason}</p>
          {sourceUrl && (
            <p>
              <a
                href={sourceUrl}
                className="source-link"
                target="_blank"
                rel="noreferrer"
              >
                Apri il portale originale
              </a>
            </p>
          )}
          <p>
            Seleziona i passaggi originali che sostengono il confronto con la
            ditta. I marcatori HTML sono mostrati come testo.
          </p>
          {selected.expected.sourceDependency.selectionHash && (
            <>
              {selected.texts
                .filter((entry) => entry.documentary)
                .map((entry) => (
                  <OriginalText
                    key={entry.path}
                    entry={entry}
                    selectionHash={
                      selected.expected.sourceDependency.selectionHash!
                    }
                    onSelect={add}
                  />
                ))}
              <details className="space-top">
                <summary>Altri campi e condizioni originali</summary>
                {selected.texts
                  .filter((entry) => !entry.documentary)
                  .map((entry) => (
                    <OriginalText
                      key={entry.path}
                      entry={entry}
                      selectionHash={
                        selected.expected.sourceDependency.selectionHash!
                      }
                      onSelect={add}
                    />
                  ))}
              </details>
            </>
          )}
          {selected.original && (
            <details className="space-top">
              <summary>
                Contenuto archiviato completo del contesto selezionato
              </summary>
              <pre className="original-text">{selected.original}</pre>
            </details>
          )}
          <h3>Passaggi selezionati ({references.length})</h3>
          {references.map((ref, index) => (
            <div key={`${ref.rawPath}:${ref.startUtf16}:${ref.endUtf16}`}>
              <blockquote className="original-text">
                {selected.texts
                  .find((entry) => entry.path === ref.rawPath)
                  ?.text.slice(ref.startUtf16, ref.endUtf16)}
              </blockquote>
              <button
                type="button"
                className="button secondary"
                onClick={() =>
                  setReferences((current) =>
                    current.filter((_, i) => i !== index),
                  )
                }
              >
                Rimuovi passaggio {index + 1}
              </button>
            </div>
          ))}
          <label className="field space-top">
            Giudizio sulla pertinenza
            <select
              value={result}
              onChange={(event) =>
                setResult(event.target.value as LotAssessmentResult | "")
              }
              disabled={!selected.canAssess || busy || stale}
            >
              <option value="">Scegli il giudizio</option>
              {Object.entries(results).map(([value, label]) => (
                <option
                  key={value}
                  value={value}
                  disabled={
                    value !== "review" &&
                    (!selected.allowsCertainty ||
                      (value === "direct" && !selected.eligible))
                  }
                >
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="field space-top">
            Motivo visibile alla ditta
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              minLength={10}
              maxLength={4000}
              rows={4}
              disabled={busy || stale}
            />
          </label>
          <p>
            Descrivi il rapporto fra attività della ditta e prestazioni del
            {projectTarget ? "progetto" : "lotto"}. Mantieni le informazioni
            riservate nella nota privata.
          </p>
          {!!selected.reviewReasons.length && (
            <fieldset className="space-top">
              <legend>Punti da verificare prima di un giudizio positivo</legend>
              {selected.reviewReasons.map((item) => (
                <label className="check-label" key={item}>
                  <input
                    type="checkbox"
                    checked={confirmedReviewReasons.includes(item)}
                    onChange={(event) =>
                      setConfirmedReviewReasons((current) =>
                        event.target.checked
                          ? [...current, item]
                          : current.filter((value) => value !== item),
                      )
                    }
                    disabled={busy || stale}
                  />
                  Ho verificato: {item}
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
      <label className="field space-top">
        Nota privata della revisione
        <textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          minLength={10}
          maxLength={800}
          rows={3}
          disabled={busy || stale}
        />
      </label>
      <p>La nota resta nell’area fondatore e non viene inviata alla ditta.</p>
      {selected && (
        <div className="form-actions">
          <button
            type="button"
            className="button primary"
            disabled={busy || stale || !selected.canAssess}
            onClick={() =>
              save(projectTarget ? "assess_project" : "assess_lot")
            }
          >
            {projectTarget
              ? "Salva valutazione dell’intero progetto"
              : "Salva valutazione del lotto"}
          </button>
        </div>
      )}
      <section className="space-top">
        <h3>Decisione sull’intero progetto</h3>
        <p>
          La riconsiderazione ritira solo l’esclusione del fondatore. Non
          approva la pertinenza, non risolve dubbi sulla fonte e non modifica il
          feedback della ditta.
        </p>
        <label className="check-label">
          <input
            type="checkbox"
            checked={confirmedProjectAction}
            onChange={(event) =>
              setConfirmedProjectAction(event.target.checked)
            }
            disabled={busy || stale}
          />
          Confermo di voler{" "}
          {data.project.suppressed
            ? "riconsiderare l’esclusione dell’intero progetto"
            : "escludere l’intero progetto per questa ditta"}
          .
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy || stale}
            onClick={() =>
              save(data.project.suppressed ? "reopen_project" : "veto_project")
            }
          >
            {data.project.suppressed
              ? "Riconsidera progetto"
              : "Escludi progetto"}
          </button>
        </div>
      </section>
      {message && <p role="status">{message}</p>}
      {stale && (
        <button
          type="button"
          className="button secondary"
          onClick={() => router.refresh()}
        >
          Aggiorna la pagina
        </button>
      )}
      <details className="space-top">
        <summary>Storico delle valutazioni ({data.history.length})</summary>
        {data.history.map((item) => (
          <article key={item.id} className="space-top">
            <p>
              {item.at} ·{" "}
              {item.target?.kind === "lot"
                ? `Lotto ${data.lots.find((lot) => item.target?.kind === "lot" && lot.id === item.target.lotId)?.number ?? "non più presente"}`
                : "Intero progetto"}{" "}
              ·{" "}
              {item.result
                ? results[item.result]
                : item.action === "veto_project"
                  ? "Esclusione"
                  : "Riconsiderazione"}
            </p>
            {item.reason && <p>Motivo registrato: {item.reason}</p>}
            <p>Nota privata: {item.note}</p>
            {item.quotes.map((quote, i) => (
              <blockquote className="original-text" key={i}>
                {quote}
              </blockquote>
            ))}
          </article>
        ))}
      </details>
    </section>
  );
}
