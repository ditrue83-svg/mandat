"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Publication } from "@/lib/domain";
import type {
  DocumentaryReference,
  HumanSourceForm,
  ReviewRecord,
  SourceContext,
  SourceSnapshot,
} from "@/lib/source-review-context";
import type { DeepReadonly, SourceOrigin } from "@/lib/source-input";
import { legacyTitleTranslations } from "@/lib/source-title-differences";
import { SourceTitleNotices } from "./source-title-notices";

export type SourceReviewEditorData = {
  publication: Pick<
    Publication,
    "id" | "title" | "sourceUrl" | "sourceScopeReview"
  > & {
    sourceRevision: string;
    contentRevision: string;
  };
  snapshot: SourceSnapshot;
  history: readonly ReviewRecord[];
  context: SourceContext;
  expected: {
    eventId: string | null;
    sourceSnapshotHash: string;
    corpusHash: string | null;
  };
};

const forms: Record<HumanSourceForm, string> = {
  defined_service: "Definita — prestazione concreta identificata",
  broad_scope: "Generica — ambito noto, prestazioni da precisare",
  unclear: "Incerta — informazioni insufficienti",
  conflicting: "Discordante — informazioni incompatibili",
};
const languages = {
  it: "Italiano",
  de: "Tedesco",
  fr: "Francese",
  en: "Inglese",
};
const kinds = {
  title: "Titolo originale",
  description: "Descrizione originale",
  legacy_mixed: "Testo acquisito",
  document_page: "Documento",
};

function safeLink(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? { href: value, hostname: url.hostname }
      : null;
  } catch {
    return null;
  }
}

function Origin({ origin }: { origin: DeepReadonly<SourceOrigin> }) {
  const link = safeLink(origin.url);
  return (
    <span>
      {kinds[origin.kind]} ·{" "}
      {origin.language ? languages[origin.language] : "Lingua non indicata"}
      {origin.page !== null && ` · pagina ${origin.page}`}
      {link && (
        <>
          {" "}
          ·{" "}
          <a
            href={link.href}
            target="_blank"
            rel="noreferrer"
            className="source-link"
          >
            Apri origine ({link.hostname})
          </a>
        </>
      )}
    </span>
  );
}

function UnverifiedTexts({ snapshot }: { snapshot: SourceSnapshot }) {
  const input = snapshot.documentaryInput;
  const texts: { text: string; label: string }[] = [];
  if (typeof input.originalText === "string")
    texts.push({ text: input.originalText, label: "Testo acquisito" });
  for (const [key, label] of [
    ["originalTitles", "Titolo originale"],
    ["originalDescriptions", "Descrizione originale"],
    ["documentPages", "Documento"],
  ] as const) {
    const entries = input[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || typeof entry.text !== "string")
        continue;
      const language =
        typeof entry.language === "string" &&
        Object.hasOwn(languages, entry.language)
          ? languages[entry.language as keyof typeof languages]
          : "Lingua non indicata";
      const page =
        Number.isInteger(entry.page) && Number(entry.page) > 0
          ? ` · pagina ${entry.page}`
          : "";
      texts.push({ text: entry.text, label: `${label} · ${language}${page}` });
    }
  }
  return (
    <>
      <p className="notice">
        I dati acquisiti non consentono riferimenti verificati. Puoi aprire una
        verifica; per registrare un giudizio occorre prima correggere
        l’acquisizione della fonte.
      </p>
      {texts.map((entry, index) => (
        <div key={index} className="space-top">
          <h4>{entry.label}</h4>
          <blockquote className="original-text">{entry.text}</blockquote>
        </div>
      ))}
      {!texts.length && (
        <p>Nessun testo originale leggibile nei dati archiviati.</p>
      )}
    </>
  );
}

function OriginalTexts({
  snapshot,
  selection,
}: {
  snapshot: SourceSnapshot;
  selection?: {
    values: ReadonlySet<string>;
    disabled: boolean;
    toggle: (value: string) => void;
  };
}) {
  if (!snapshot.source.accepted) return <UnverifiedTexts snapshot={snapshot} />;
  const { corpus } = snapshot.source;
  return (
    <>
      {corpus.units.map((unit, unitIndex) => {
        const langs = new Set(unit.origins.map((origin) => origin.language));
        const language =
          langs.size === 1
            ? (unit.origins[0]?.language ?? undefined)
            : undefined;
        return (
          <section
            key={unit.id}
            className="space-top"
            aria-label={`Testo originale ${unitIndex + 1}`}
          >
            <h3>Testo {unitIndex + 1}</h3>
            <blockquote className="original-text" lang={language}>
              {unit.text}
            </blockquote>
            {unit.origins.map((origin, originIndex) => {
              const value = `${unitIndex}:${originIndex}`;
              return (
                <div key={originIndex} className="space-top">
                  <p className="meta">
                    <Origin origin={origin} />
                  </p>
                  {selection && (
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={selection.values.has(value)}
                        disabled={selection.disabled}
                        onChange={() => selection.toggle(value)}
                      />
                      Cita questo testo da questa origine
                    </label>
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      <section className="space-top" aria-label="Documenti collegati">
        <h3>Documenti collegati</h3>
        <p className="meta">
          Sono mostrati i testi archiviati da Mandat. Il contenuto dei documenti
          non acquisiti non è stato verificato; le altre lingue potrebbero non
          essere disponibili.
        </p>
        {!corpus.coverage.documentLinks.length && (
          <p>Nessun documento collegato nei dati acquisiti.</p>
        )}
        {corpus.coverage.documentLinks.map((document, index) => {
          const link = safeLink(document.url);
          return (
            <p key={index}>
              {link ? (
                <a
                  href={link.href}
                  target="_blank"
                  rel="noreferrer"
                  className="source-link"
                >
                  {document.title || "Documento originale"}
                </a>
              ) : (
                document.title || "Documento originale"
              )}
              {" · "}
              {document.requiresLogin
                ? "Accesso richiesto sul portale originale"
                : document.availability === "text_available"
                  ? "Pagine acquisite riportate sopra"
                  : "Contenuto non acquisito"}
            </p>
          );
        })}
      </section>
    </>
  );
}

function contextMessage(context: SourceContext) {
  if (context.state === "pending")
    return "Nessun giudizio umano registrato per questa fonte.";
  if (context.state === "input_refused")
    return "L’acquisizione della fonte richiede una verifica.";
  if (context.state === "manual_source")
    return context.form === "broad_scope"
      ? "Fonte generica: il giudizio è registrato, ma le prestazioni restano da precisare e la fonte rimane in revisione."
      : "Fonte definita: è stato registrato un giudizio umano sulla prestazione descritta.";
  if (context.reason === "source_changed")
    return "La fonte è cambiata dopo il giudizio precedente. Occorre una nuova revisione dei testi attuali.";
  if (context.reason === "explicit_open")
    return "Verifica della fonte aperta: il giudizio resta da completare.";
  return "Fonte incerta o discordante: resta in revisione.";
}

type Submission = {
  demo: boolean;
  publicationId: string;
  expected: SourceReviewEditorData["expected"];
  action: "opened" | "recorded";
  form: HumanSourceForm | null;
  references: readonly DocumentaryReference[];
  note: string;
};
type SaveResult = { state: "saved" | "stale" | "error"; message: string };

export async function submitSourceReview(
  input: Submission,
  refresh: () => void,
): Promise<SaveResult> {
  if (input.demo)
    return { state: "error", message: "La demo non registra revisioni." };
  if (input.note.trim().length < 10 || input.note.trim().length > 800)
    return {
      state: "error",
      message: "Scrivi una nota privata da 10 a 800 caratteri.",
    };
  if (input.action === "recorded" && (!input.form || !input.references.length))
    return {
      state: "error",
      message: "Scegli una forma e almeno un riferimento originale.",
    };
  try {
    const response = await fetch("/api/admin/source-reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        publicationId: input.publicationId,
        expectedEventId: input.expected.eventId,
        expectedSourceSnapshotHash: input.expected.sourceSnapshotHash,
        expectedCorpusHash: input.expected.corpusHash,
        action: input.action,
        form: input.action === "opened" ? null : input.form,
        references: input.action === "opened" ? [] : input.references,
        note: input.note,
      }),
    });
    if (response.status === 409)
      return {
        state: "stale",
        message:
          "La fonte o la sua revisione è cambiata. Aggiorna la pagina e ricontrolla i testi prima di registrare il giudizio.",
      };
    if (!response.ok)
      return {
        state: "error",
        message:
          "Revisione non registrata. Riprova dopo aver verificato l’accesso all’area fondatore.",
      };
    refresh();
    return {
      state: "saved",
      message:
        input.action === "opened"
          ? "Verifica aperta. Aggiornamento della pagina in corso."
          : "Giudizio registrato. Aggiornamento della pagina in corso.",
    };
  } catch {
    return {
      state: "error",
      message:
        "Non è stato possibile confermare il salvataggio. Aggiorna la pagina e controlla lo storico prima di riprovare.",
    };
  }
}

export function SourceReviewEditor({
  data,
  demo,
}: {
  data: SourceReviewEditorData;
  demo: boolean;
}) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SaveResult | null>(null);
  const [form, setForm] = useState<HumanSourceForm | "">("");
  const [note, setNote] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const disabled =
    demo || busy || result?.state === "stale" || result?.state === "saved";
  const corpus = data.snapshot.source.accepted
    ? data.snapshot.source.corpus
    : null;
  const sourceLink = safeLink(data.publication.sourceUrl);
  async function save(action: "opened" | "recorded") {
    if (disabled || inFlight.current) return;
    const references: DocumentaryReference[] = [];
    corpus?.units.forEach((unit, unitIndex) =>
      unit.origins.forEach((_, originIndex) => {
        if (selected.has(`${unitIndex}:${originIndex}`))
          references.push({
            unitId: unit.id,
            originIndex,
            startUtf16: 0,
            endUtf16: unit.text.length,
          });
      }),
    );
    inFlight.current = true;
    setBusy(true);
    setResult(null);
    try {
      setResult(
        await submitSourceReview(
          {
            demo,
            publicationId: data.publication.id,
            expected: data.expected,
            action,
            form: form || null,
            references,
            note,
          },
          () => router.refresh(),
        ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <section className="detail-heading">
        <div className="eyebrow">REVISIONE UMANA DELLA FONTE</div>
        <h1>{data.publication.title}</h1>
        <p>
          Leggi tutte le versioni linguistiche disponibili e distingui le
          prestazioni richieste dalle categorie generiche.
        </p>
        {sourceLink && (
          <a
            href={sourceLink.href}
            target="_blank"
            rel="noreferrer"
            className="source-link"
          >
            Apri la pubblicazione originale
          </a>
        )}
      </section>
      {demo && (
        <p className="notice">
          Anteprima con dati inventati. La demo non registra revisioni.
        </p>
      )}
      <p className="notice" role="status">
        {contextMessage(data.context)}
      </p>
      {data.publication.sourceScopeReview?.status === "required" && (
        <div className="notice" role="alert">
          È aperto anche un dubbio sull’oggetto nei controlli precedenti. Rimane
          distinto da questo giudizio e non viene risolto registrando una forma
          della fonte.
          {data.publication.sourceScopeReview.sourceRevision !==
            data.publication.sourceRevision &&
            " Quel dubbio riguarda una versione precedente e deve essere ricontrollato."}
        </div>
      )}
      <section className="panel">
        <h2>Testi originali e riferimenti</h2>
        <SourceTitleNotices
          titles={legacyTitleTranslations(
            data.snapshot.documentaryInput.originalTitles,
          )}
        />
        <p>
          Scegli i testi e le rispettive origini che sostengono il giudizio.
          Ogni selezione cita il testo intero, senza modificarlo.
        </p>
        <OriginalTexts
          snapshot={data.snapshot}
          selection={{
            values: selected,
            disabled: !!disabled,
            toggle: (value) =>
              setSelected((previous) => {
                const next = new Set(previous);
                if (next.has(value)) next.delete(value);
                else next.add(value);
                return next;
              }),
          }}
        />
      </section>
      <section className="panel">
        <h2>Registra la verifica</h2>
        <p>
          Una categoria, anche con un oggetto o un luogo, può restare generica.
          Due modalità di eseguire lo stesso lavoro non dimostrano che siano
          state identificate tutte le prestazioni dell’incarico.
        </p>
        <p className="meta">
          Il giudizio riguarda la fonte e vale indipendentemente dalle ditte. Le
          citazioni non attestano l’idoneità a partecipare. Questa registrazione
          non approva proposte e non abilita invii.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save("recorded");
          }}
        >
          <label className="field">
            Forma della fonte
            <select
              value={form}
              onChange={(event) =>
                setForm(event.target.value as HumanSourceForm | "")
              }
              disabled={!!disabled || !corpus}
            >
              <option value="">Scegli dopo aver letto i testi</option>
              {Object.entries(forms).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p className="meta">
            Generica, incerta o discordante: la fonte rimane in revisione. Una
            prestazione definita richiede comunque una revisione manuale della
            pertinenza per ogni ditta.
          </p>
          <label className="field">
            Nota privata sulla verifica
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              required
              minLength={10}
              maxLength={800}
              disabled={!!disabled}
              placeholder="Descrivi ciò che la fonte afferma, i passaggi rilevanti e gli eventuali dubbi. Le note restano nell’area fondatore."
            />
          </label>
          <p className="meta">
            {selected.size} riferimenti selezionati. Nota e citazioni rimangono
            nello storico privato.
          </p>
          <div className="form-actions" style={{ flexWrap: "wrap" }}>
            <button
              type="button"
              className="button secondary"
              disabled={
                !!disabled ||
                note.trim().length < 10 ||
                note.trim().length > 800
              }
              onClick={() => void save("opened")}
            >
              Apri una verifica
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={
                !!disabled ||
                !corpus ||
                !form ||
                !selected.size ||
                note.trim().length < 10 ||
                note.trim().length > 800
              }
            >
              Registra il giudizio
            </button>
          </div>
        </form>
        {result && (
          <p
            role={result.state === "saved" ? "status" : "alert"}
            className="notice"
          >
            {result.message}
          </p>
        )}
        {result && result.state !== "saved" && (
          <button
            className="button secondary"
            type="button"
            onClick={() => router.refresh()}
          >
            Aggiorna la pagina
          </button>
        )}
      </section>
      <section className="panel" aria-label="Storico privato della fonte">
        <h2>Storico privato della fonte</h2>
        {!data.history.length && <p>Nessuna revisione registrata.</p>}
        {[...data.history].reverse().map(({ event, snapshot }) => (
          <article key={event.id} className="space-top">
            <h3>
              Revisione {event.sequence} ·{" "}
              {event.action === "opened"
                ? "Verifica aperta"
                : event.form
                  ? forms[event.form]
                  : "Giudizio da verificare"}
            </h3>
            <p className="meta">
              <time dateTime={event.createdAt}>
                {new Intl.DateTimeFormat("it-CH", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "Europe/Zurich",
                }).format(new Date(event.createdAt))}
              </time>{" "}
              · ora svizzera
            </p>
            <p className="meta">
              {snapshot.sourceSnapshotHash === data.snapshot.sourceSnapshotHash
                ? "Riferita ai testi attualmente acquisiti."
                : "Riferita a una versione precedente della fonte; non è un giudizio sui testi attuali."}
            </p>
            <p className="original-text">{event.note}</p>
            {event.evidence.map((reference, index) => (
              <div key={index} className="space-top">
                <p className="meta">
                  <Origin origin={reference.origin} />
                </p>
                <blockquote
                  className="original-text"
                  lang={reference.origin.language ?? undefined}
                >
                  {reference.quote}
                </blockquote>
              </div>
            ))}
            <details className="space-top">
              <summary>Leggi i testi archiviati per questa revisione</summary>
              <OriginalTexts snapshot={snapshot} />
            </details>
          </article>
        ))}
      </section>
    </>
  );
}
