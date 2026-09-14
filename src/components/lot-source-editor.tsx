"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { LotSourceEditorData } from "@/lib/lot-source-editor-data";
import type { LotDocumentaryReference } from "@/lib/lot-source-context";
import type { HumanSourceForm } from "@/lib/source-review-context";
import { documentaryTitleTranslations } from "@/lib/source-title-differences";
import { SourceTitleNotices } from "./source-title-notices";

const forms: Record<HumanSourceForm, string> = {
  defined_service: "Prestazione concreta identificata",
  broad_scope: "Ambito generico: prestazioni da precisare",
  unclear: "Informazioni insufficienti",
  conflicting: "Informazioni discordanti",
};
type Submission = {
  data: LotSourceEditorData;
  action: "opened" | "recorded";
  form: HumanSourceForm | "";
  references: LotDocumentaryReference[];
  note: string;
  resolveLegacyScope: boolean;
};
export async function submitLotSourceReview(input: Submission) {
  const { data, action } = input;
  if (input.note.trim().length < 10 || input.note.trim().length > 800)
    return {
      ok: false,
      stale: false,
      message: "Scrivi una nota da 10 a 800 caratteri.",
    };
  if (action === "recorded" && (!input.form || !input.references.length))
    return {
      ok: false,
      stale: false,
      message: "Scegli il giudizio e almeno un passaggio originale.",
    };
  const response = await fetch("/api/admin/lot-source-reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      target: data.target,
      expectedObservationId: data.expected.observationId,
      expectedSnapshotHash: data.expected.snapshotHash,
      expectedSelectionHash: data.expected.selectionHash,
      expectedTargetEventId: data.expected.targetEventId,
      expectedProjectBarrierHash: data.expected.projectBarrierHash,
      expectedShapeEpochToken: data.expected.shapeEpochToken,
      action,
      form: action === "recorded" ? input.form : null,
      references: action === "recorded" ? input.references : [],
      note: input.note.trim(),
      resolveLegacyScope: action === "recorded" && input.resolveLegacyScope,
    }),
  });
  if (response.status === 409)
    return {
      ok: false,
      stale: true,
      message:
        "La fonte o la revisione sono cambiate. Aggiorna la pagina prima di salvare.",
    };
  if (!response.ok)
    return {
      ok: false,
      stale: false,
      message: "Revisione non salvata. Controlla i riferimenti e riprova.",
    };
  return { ok: true, stale: false, message: "Revisione della fonte salvata." };
}

export function OriginalText({
  entry,
  selectionHash,
  onSelect,
}: {
  entry: LotSourceEditorData["texts"][number];
  selectionHash: string;
  onSelect: (ref: LotDocumentaryReference) => void;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  return (
    <div className="space-top field">
      <p>
        <strong>
          {entry.scope === "lot" ? "Testo del lotto" : "Contesto del progetto"}
        </strong>
      </p>
      <textarea
        ref={area}
        readOnly
        value={entry.text}
        rows={Math.min(10, Math.max(2, entry.text.split("\n").length))}
        aria-label={`Testo originale ${entry.path}`}
        className="original-text"
        onSelect={(event) =>
          setRange({
            start: event.currentTarget.selectionStart,
            end: event.currentTarget.selectionEnd,
          })
        }
      />
      <button
        type="button"
        className="button secondary"
        disabled={range.end <= range.start || range.end - range.start > 18000}
        onClick={() =>
          onSelect({
            selectionHash,
            rawPath: entry.path,
            startUtf16: range.start,
            endUtf16: range.end,
          })
        }
      >
        Usa il passaggio selezionato
      </button>
      <details>
        <summary>Riferimento nell’originale</summary>
        <code>{entry.path}</code>
      </details>
    </div>
  );
}

export function LotSourceEditor({ data }: { data: LotSourceEditorData }) {
  const router = useRouter();
  const [references, setReferences] = useState<LotDocumentaryReference[]>([]);
  const [form, setForm] = useState<HumanSourceForm | "">("");
  const [note, setNote] = useState("");
  const [resolveLegacyScope, setResolveLegacyScope] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [stale, setStale] = useState(false);
  const submitting = useRef(false);
  const path = `/admin/fonti/${encodeURIComponent(data.publication.id)}/lotti`;
  const target = data.target;
  const selectedLot =
    target.kind === "lot"
      ? data.directory.find(
          (lot) => lot.id.toLowerCase() === target.lotId.toLowerCase(),
        )
      : null;
  let sourceUrl: string | null = null;
  try {
    const url = new URL(data.publication.sourceUrl);
    if (url.protocol === "https:" && !url.username && !url.password)
      sourceUrl = url.href;
  } catch {
    /* An invalid original URL is not rendered as an active link. */
  }
  const add = (reference: LotDocumentaryReference) =>
    setReferences((current) =>
      current.some(
        (ref) => JSON.stringify(ref) === JSON.stringify(reference),
      ) || current.length >= 128
        ? current
        : [...current, reference],
    );
  async function save(action: "opened" | "recorded") {
    if (submitting.current || stale) return;
    submitting.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await submitLotSourceReview({
        data,
        action,
        form,
        references,
        note,
        resolveLegacyScope,
      });
      setMessage(result.message);
      setStale(result.stale);
      if (result.ok) {
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
      <p className="eyebrow">Revisione della fonte</p>
      <h1>{data.publication.title}</h1>
      <p>
        Esamina il progetto e gli eventuali lotti separatamente. Questo giudizio
        descrive la fonte; la pertinenza per una ditta richiede una valutazione
        distinta.
      </p>
      <nav aria-label="Progetto e lotti" className="lot-source-nav">
        <Link
          href={path}
          aria-current={data.target.kind === "project" ? "page" : undefined}
        >
          {data.shape.kind === "project" ? "Intero progetto" : "Progetto"}
        </Link>
        {data.directory.map((lot) => (
          <Link
            key={lot.id}
            href={`${path}?lot=${encodeURIComponent(lot.id)}`}
            aria-current={selectedLot?.id === lot.id ? "page" : undefined}
          >
            Lotto {lot.number}
          </Link>
        ))}
      </nav>
      <h2>
        {data.target.kind === "project"
          ? data.shape.kind === "project"
            ? "Intero progetto — gara senza lotti"
            : "Contesto del progetto"
          : selectedLot
            ? `Lotto ${selectedLot.number}`
            : "Lotto non più presente"}
      </h2>
      {data.shape.kind === "unresolved" && (
        <p className="notice">
          La struttura della gara non è verificata. Un giudizio sulla fonte non
          risolve l’assenza o la discordanza dei dati sui lotti e non abilita
          una valutazione certa per la ditta.
        </p>
      )}
      {data.projectBlocked && (
        <p className="notice">
          Il progetto richiede una verifica. Finché resta aperta, non può
          sostenere una proposta positiva per la ditta.
        </p>
      )}
      {data.state === "input_refused" && (
        <p className="notice">
          L’archivio non consente una revisione verificabile di questo
          contenuto. Puoi registrare il problema e aprire una verifica.
        </p>
      )}
      {sourceUrl && (
        <p>
          <a
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="source-link"
          >
            Apri il portale originale
          </a>
        </p>
      )}
      <p>
        Seleziona nel testo i passaggi che sostengono il giudizio. Il testo
        originale può contenere marcatori HTML, mostrati come testo.
      </p>
      <SourceTitleNotices titles={documentaryTitleTranslations(data.texts)} />
      {data.expected.selectionHash && (
        <>
          {data.texts
            .filter((entry) => entry.documentary)
            .map((entry) => (
              <OriginalText
                key={entry.path}
                entry={entry}
                selectionHash={data.expected.selectionHash!}
                onSelect={add}
              />
            ))}
          <details className="space-top">
            <summary>Altri campi e condizioni originali</summary>
            {data.texts
              .filter((entry) => !entry.documentary)
              .map((entry) => (
                <OriginalText
                  key={entry.path}
                  entry={entry}
                  selectionHash={data.expected.selectionHash!}
                  onSelect={add}
                />
              ))}
          </details>
        </>
      )}
      {data.original && (
        <details className="space-top">
          <summary>
            Contenuto archiviato completo del contesto selezionato
          </summary>
          <pre className="original-text">{data.original}</pre>
        </details>
      )}
      <h3>Passaggi selezionati ({references.length})</h3>
      {references.map((ref, index) => (
        <div key={`${ref.rawPath}:${ref.startUtf16}:${ref.endUtf16}`}>
          <blockquote className="original-text">
            {data.texts
              .find((entry) => entry.path === ref.rawPath)
              ?.text.slice(ref.startUtf16, ref.endUtf16)}
          </blockquote>
          <button
            type="button"
            className="button secondary"
            onClick={() =>
              setReferences((current) => current.filter((_, i) => i !== index))
            }
          >
            Rimuovi passaggio {index + 1}
          </button>
        </div>
      ))}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save("recorded");
        }}
        className="space-top"
      >
        <label className="field">
          Giudizio sulla fonte
          <select
            value={form}
            onChange={(event) =>
              setForm(event.target.value as HumanSourceForm | "")
            }
          >
            <option value="">Scegli il giudizio</option>
            {Object.entries(forms).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Nota della revisione
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            minLength={10}
            maxLength={800}
            rows={4}
          />
        </label>
        {data.target.kind === "project" &&
          data.publication.sourceScopeReview?.status === "required" && (
            <label className="check-label">
              <input
                type="checkbox"
                checked={resolveLegacyScope}
                onChange={(event) =>
                  setResolveLegacyScope(event.target.checked)
                }
              />
              Ho verificato anche il dubbio già aperto sull’oggetto e ne
              confermo la risoluzione.
            </label>
          )}
        <div className="form-actions" style={{ flexWrap: "wrap" }}>
          <button
            className="button primary"
            type="submit"
            disabled={busy || stale || !data.expected.selectionHash}
          >
            Salva revisione della fonte
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy || stale}
            onClick={() => void save("opened")}
          >
            Apri una verifica
          </button>
        </div>
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
      </form>
      <details className="space-top">
        <summary>Storico delle revisioni ({data.history.length})</summary>
        {data.history.map((event) => (
          <article key={event.id} className="space-top">
            <h3>{event.target}</h3>
            <p>
              {event.at} ·{" "}
              {event.action === "opened"
                ? "Verifica aperta"
                : event.form && forms[event.form as HumanSourceForm]}
            </p>
            <p>{event.note}</p>
            {event.quotes.map((quote, index) => (
              <blockquote key={index} className="original-text">
                {quote}
              </blockquote>
            ))}
          </article>
        ))}
      </details>
    </section>
  );
}
