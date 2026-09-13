import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureSourceSnapshot,
  createSourceReviewRecord,
  resolveSourceContext,
  type HumanSourceForm,
  type ReviewRecord,
  type SourceSnapshot,
} from "../src/lib/source-review-context";
import {
  SourceReviewEditor,
  submitSourceReview,
  type SourceReviewEditorData,
} from "../src/components/source-review-editor";
import { demoViewer } from "../src/lib/demo";

const mocks = vi.hoisted(() => ({
  pageViewer: vi.fn(),
  load: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  usePathname: () => "/admin/fonti/invented",
  notFound: () => {
    throw new Error("not-found");
  },
}));
vi.mock("@/lib/viewer", () => ({
  pageViewer: mocks.pageViewer,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/source-reviews", () => ({
  loadSourceReviewContext: mocks.load,
}));
import SourceReviewPage from "../src/app/admin/fonti/[id]/page";
import { HttpError } from "../src/lib/viewer";

// All documentary text, people, identifiers and URLs in this file are invented.
const url = "https://sources.example.invalid/notice";
const documentUrl = "https://sources.example.invalid/document.pdf";
const sourceText =
  "Avviso inventato 🧰\nRegolazione delle porte della casa comunale immaginaria.\nFINE DEL TESTO ORIGINALE";
function snapshot(overrides: Record<string, unknown> = {}) {
  return captureSourceSnapshot("invented-publication", {
    sourceUrl: url,
    originalText: sourceText,
    originalTitles: [
      {
        language: "it",
        text: "Titolo italiano inventato",
        path: "title.it",
        url,
      },
      { language: "fr", text: "Titre français inventé", path: "title.fr", url },
    ],
    originalDescriptions: [
      {
        language: "de",
        text: "  <script>non eseguire</script> Türen einstellen.  ",
        url,
      },
      { language: "fr", text: "Régler les portes du bâtiment fictif.", url },
    ],
    documentPages: [
      {
        page: 2,
        text: "Pagina inventata: sostituire i cilindri usurati.",
        url: documentUrl,
      },
    ],
    documents: [
      {
        title: "Documento inventato acquisito",
        url: documentUrl,
        requiresLogin: false,
      },
      {
        title: "Allegato inventato riservato",
        url: "https://sources.example.invalid/reserved",
        requiresLogin: true,
      },
    ],
    ...overrides,
  });
}
function data(
  current = snapshot(),
  history: readonly ReviewRecord[] = [],
): SourceReviewEditorData {
  const context = resolveSourceContext(current, history);
  return {
    publication: {
      id: "invented-publication",
      title: "Revisione di una fonte inventata",
      sourceUrl: url,
      sourceRevision: "source-version-current",
      contentRevision: "content-version-current",
    },
    snapshot: current,
    history,
    context,
    expected: {
      eventId: context.dependency.reviewEventId,
      sourceSnapshotHash: current.sourceSnapshotHash,
      corpusHash: context.dependency.corpusHash,
    },
  };
}
function reference(current: SourceSnapshot) {
  if (!current.source.accepted)
    throw new Error("Fixture must have an accepted corpus");
  const unit = current.source.corpus.units[0];
  return {
    unitId: unit.id,
    originIndex: 0,
    startUtf16: 0,
    endUtf16: unit.text.length,
  };
}
function record(
  current: SourceSnapshot,
  form: HumanSourceForm = "defined_service",
) {
  return createSourceReviewRecord(
    {
      publicationId: current.publicationId,
      expectedEventId: null,
      expectedSourceSnapshotHash: current.sourceSnapshotHash,
      expectedCorpusHash: current.source.accepted
        ? current.source.corpus.inputHash
        : null,
      action: "recorded",
      form,
      references: [reference(current)],
      actorId: "opaque-private-actor-id",
      note: "Nota privata inventata: prestazione da confrontare separatamente con la ditta.",
    },
    current,
    [],
    {
      id: "opaque-private-event-id",
      sourceRevision: "old-source-version",
      contentRevision: "old-content-version",
      createdAt: "2026-01-02T08:00:00.000Z",
    },
  );
}
function render(input = data(), demo = false) {
  return renderToStaticMarkup(
    createElement(SourceReviewEditor, { data: input, demo }),
  );
}
function expectPlainClientData(value: unknown) {
  if (value === null || typeof value !== "object") return;
  expect(Object.getPrototypeOf(value)).toBe(
    Array.isArray(value) ? Array.prototype : Object.prototype,
  );
  Object.values(value).forEach(expectPlainClientData);
}
async function pageEditorData(input: SourceReviewEditorData) {
  mocks.pageViewer.mockResolvedValue({ ...demoViewer, demo: false });
  mocks.load.mockResolvedValue(input);
  const page = await SourceReviewPage({
    params: Promise.resolve({ id: input.publication.id }),
  });
  const editor = Children.toArray(page.props.children).find(
    (child) => isValidElement(child) && child.type === SourceReviewEditor,
  ) as ReactElement<{ data: SourceReviewEditorData }>;
  expect(editor).toBeDefined();
  return editor.props.data;
}
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("testi e storico privato", () => {
  it("mostra i testi interi, tutte le lingue e le pagine con origine, senza rendere HTML attivo", () => {
    const html = render();
    expect(html).toContain(sourceText);
    expect(html).toContain("Titre français inventé");
    expect(html).toContain("Régler les portes du bâtiment fictif.");
    expect(html).toContain(
      "  &lt;script&gt;non eseguire&lt;/script&gt; Türen einstellen.  ",
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain('lang="de"');
    expect(html).toContain('lang="fr"');
    expect(html).toContain("Tedesco");
    expect(html).toContain("pagina 2");
    expect(html).toContain(`href="${documentUrl}"`);
    expect(html).toContain("Accesso richiesto sul portale originale");
    expect(html).toContain(
      "Il contenuto dei documenti non acquisiti non è stato verificato",
    );
  });
  it("separa selezione del testo e origine anche quando il testo è condiviso", () => {
    const current = snapshot({
      originalTitles: [
        { language: "it", text: "Testo condiviso", path: "title.it", url },
        { language: "fr", text: "Testo condiviso", path: "title.fr", url },
      ],
    });
    if (!current.source.accepted) throw new Error("Invalid fixture");
    const html = render(data(current));
    expect(html.match(/>Testo condiviso<\/blockquote>/g)).toHaveLength(1);
    const originCount = current.source.corpus.units.reduce(
      (count, unit) => count + unit.origins.length,
      0,
    );
    expect(html.match(/type="checkbox"/g)).toHaveLength(originCount);
    expect(html.match(/Cita questo testo da questa origine/g)).toHaveLength(
      originCount,
    );
  });
  it("non presenta il giudizio della fonte o le citazioni come approvazione aziendale", () => {
    const html = render();
    expect(html).toContain("Nessun giudizio umano registrato");
    expect(html).toContain(
      "Le citazioni non attestano l’idoneità a partecipare",
    );
    expect(html).toContain("non approva proposte e non abilita invii");
    expect(html).toContain(
      "Generica, incerta o discordante: la fonte rimane in revisione",
    );
    expect(html).toContain("Scegli dopo aver letto i testi");
  });
  it.each(["broad_scope", "unclear", "conflicting"] as const)(
    "mantiene visibile la revisione per la forma %s",
    (form) => {
      const current = snapshot();
      const html = render(data(current, [record(current, form)]));
      expect(html).toMatch(/(?:rimane|resta) in revisione/);
      expect(html).not.toContain("Fonte definita: è stato registrato");
    },
  );
  it("conserva note e testi storici, distinguendo la versione precedente da quella attuale", () => {
    const old = snapshot({ originalText: "TESTO STORICO INVENTATO" });
    const current = snapshot({ originalText: "TESTO ATTUALE INVENTATO" });
    const history = [record(old)];
    const html = render(data(current, history));
    expect(html).toContain("La fonte è cambiata dopo il giudizio precedente");
    expect(html).toContain("TESTO STORICO INVENTATO");
    expect(html).toContain("TESTO ATTUALE INVENTATO");
    expect(html).toContain(history[0].event.note);
    expect(html).toContain("non è un giudizio sui testi attuali");
    expect(html).toContain("Leggi i testi archiviati per questa revisione");
    for (const token of [
      history[0].event.actorId,
      history[0].event.id,
      history[0].event.eventHash,
      old.sourceSnapshotHash,
      current.sourceSnapshotHash,
    ])
      expect(html).not.toContain(token);
  });
  it("un nuovo giudizio definito non presenta come risolto il dubbio legacy aperto", () => {
    const current = snapshot();
    const input = data(current, [record(current)]);
    input.publication.sourceScopeReview = {
      status: "required",
      kind: "conflicting",
      token: "legacy-token-hidden",
      sourceRevision: "other-source-version",
      updatedAt: "2026-01-01T08:00:00.000Z",
    };
    const html = render(input);
    expect(html).toContain(
      "non viene risolto registrando una forma della fonte",
    );
    expect(html).toContain("deve essere ricontrollato");
    expect(html).not.toContain("Conferma risoluzione");
    expect(html).not.toContain("legacy-token-hidden");
  });
  it("mostra per intero un testo oltre il limite, senza renderlo selezionabile come prova verificata", () => {
    const current = snapshot({
      originalText: `INIZIO ${"x".repeat(18001)} FINE NON TAGLIATA`,
    });
    expect(current.source.accepted).toBe(false);
    const html = render(data(current));
    expect(html).toContain(`INIZIO ${"x".repeat(18001)} FINE NON TAGLIATA`);
    expect(html).toContain("non consentono riferimenti verificati");
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Registra il giudizio/);
    expect(html).toContain("Apri una verifica");
  });
  it("rende inattive le azioni in demo e rifiuta link con protocolli eseguibili", () => {
    const input = data();
    input.publication.sourceUrl = "javascript:alert(1)";
    const html = render(input, true);
    expect(html).toContain("La demo non registra revisioni");
    expect(html).not.toContain("javascript:");
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
    expect(
      html.match(/<input[^>]*type="checkbox"[^>]*disabled=""/g),
    ).toHaveLength(
      input.snapshot.source.accepted
        ? input.snapshot.source.corpus.units.reduce(
            (n, unit) => n + unit.origins.length,
            0,
          )
        : 0,
    );
  });
});

describe("salvataggio della revisione", () => {
  function submission() {
    const input = data();
    return {
      demo: false,
      publicationId: input.publication.id,
      expected: input.expected,
      action: "recorded" as const,
      form: "defined_service" as const,
      references: [reference(input.snapshot)],
      note: "Nota privata inventata per il salvataggio.",
    };
  }
  it("invia i riferimenti integrali e i tre valori attesi; esclude attore e ditta e aggiorna dopo il successo", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const input = Object.assign(submission(), {
      actorId: "never-trust-client-actor",
      companyId: "not-a-company-review",
    });
    const result = await submitSourceReview(input, mocks.refresh);
    expect(result.state).toBe("saved");
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    const [endpoint, options] = fetcher.mock.calls[0];
    expect(endpoint).toBe("/api/admin/source-reviews");
    expect(options.method).toBe("POST");
    const body = JSON.parse(options.body);
    expect(body).toEqual({
      publicationId: input.publicationId,
      expectedEventId: null,
      expectedSourceSnapshotHash: input.expected.sourceSnapshotHash,
      expectedCorpusHash: input.expected.corpusHash,
      action: "recorded",
      form: "defined_service",
      references: input.references,
      note: input.note,
    });
    expect(body).not.toHaveProperty("actorId");
    expect(body).not.toHaveProperty("companyId");
    const current = data().snapshot;
    if (!current.source.accepted) throw new Error("Invalid fixture");
    expect(body.references[0].endUtf16).toBe(
      current.source.corpus.units[0].text.length,
    );
  });
  it("aprire una verifica invia sempre form null e riferimenti vuoti, anche senza corpus utilizzabile", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const input = submission();
    await submitSourceReview(
      {
        ...input,
        action: "opened",
        expected: { ...input.expected, corpusHash: null },
      },
      mocks.refresh,
    );
    const body = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(body.form).toBeNull();
    expect(body.references).toEqual([]);
    expect(body.expectedCorpusHash).toBeNull();
  });
  it("non effettua richieste in demo", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const result = await submitSourceReview(
      { ...submission(), demo: true },
      mocks.refresh,
    );
    expect(result.state).toBe("error");
    expect(fetcher).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it.each([{ note: "  " }, { form: null }, { references: [] }])(
    "richiede nota, forma e almeno un riferimento prima di registrare: %j",
    async (override) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      expect(
        (
          await submitSourceReview(
            { ...submission(), ...override },
            mocks.refresh,
          )
        ).state,
      ).toBe("error");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("su conflitto 409 chiede un aggiornamento senza retry o successo apparente", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await submitSourceReview(submission(), mocks.refresh);
    expect(result.state).toBe("stale");
    expect(result.message).toContain("Aggiorna la pagina");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it.each([403, 500])(
    "non presenta un errore HTTP %s come salvataggio",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response(null, { status })),
      );
      expect(
        (await submitSourceReview(submission(), mocks.refresh)).state,
      ).toBe("error");
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );
  it("in caso di esito di rete incerto chiede di controllare lo storico prima di riprovare", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("private transport detail")),
    );
    const result = await submitSourceReview(submission(), mocks.refresh);
    expect(result.message).toContain("controlla lo storico");
    expect(result.message).not.toContain("private transport detail");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});

describe("pagina riservata alla revisione della fonte", () => {
  it("passa al client solo oggetti ordinari, preservando corpus, storico e aspettative della fonte", async () => {
    const current = snapshot();
    const input = data(current, [record(current)]);
    input.publication.sourceScopeReview = undefined;
    const documents = current.documentaryInput.documents as readonly object[];
    expect(Object.getPrototypeOf(documents[0])).toBeNull();
    expect(Object.isFrozen(documents[0])).toBe(true);

    // Static markup alone does not exercise the Server Component boundary.
    // Inspect the actual props supplied by the page to its Client Component.
    const dto = await pageEditorData(input);
    expectPlainClientData(dto);
    expect(dto).toEqual(input);
    expect(dto).not.toBe(input);
    expect(dto.snapshot).not.toBe(current);
    expect(Object.hasOwn(dto.publication, "sourceScopeReview")).toBe(true);
    expect(dto.publication.sourceScopeReview).toBeUndefined();
    expect(dto.expected).toEqual(input.expected);
    expect(dto.history[0].event.eventHash).toBe(
      input.history[0].event.eventHash,
    );
    expect(
      captureSourceSnapshot(
        current.publicationId,
        dto.snapshot.documentaryInput,
      ),
    ).toEqual(current);
    expect(resolveSourceContext(dto.snapshot, dto.history)).toEqual(
      input.context,
    );
    expect(Object.getPrototypeOf(documents[0])).toBeNull();
    expect(Object.isFrozen(current)).toBe(true);
  });
  it("preserva null, dati marcati e la proprietà __proto__ nella vista di un input rifiutato", async () => {
    const metadata = Object.fromEntries([
      ["__proto__", { marker: "dato inventato", nullable: null }],
      ["tagged", { type: "invented-tag", value: null }],
    ]);
    const current = snapshot({
      documents: [
        {
          url: documentUrl,
          title: "Documento inventato",
          requiresLogin: false,
          metadata,
        },
      ],
    });
    expect(current.source.accepted).toBe(false);
    const input = data(current);
    const dto = await pageEditorData(input);
    expectPlainClientData(dto);
    expect(dto).toEqual(input);
    const copied = (
      dto.snapshot.documentaryInput.documents as { metadata: typeof metadata }[]
    )[0].metadata;
    expect(Object.hasOwn(copied, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(copied)).toBe(Object.prototype);
    expect(copied.__proto__).toEqual({
      marker: "dato inventato",
      nullable: null,
    });
    expect(copied.tagged).toEqual({ type: "invented-tag", value: null });
    expect(
      captureSourceSnapshot(
        current.publicationId,
        dto.snapshot.documentaryInput,
      ).sourceSnapshotHash,
    ).toBe(current.sourceSnapshotHash);
    expect(dto.expected).toEqual(input.expected);
  });
  it("richiede il fondatore prima di caricare la fonte", async () => {
    mocks.pageViewer.mockRejectedValue(new Error("redirect to access"));
    await expect(
      SourceReviewPage({ params: Promise.resolve({ id: "invented" }) }),
    ).rejects.toThrow("redirect to access");
    expect(mocks.pageViewer).toHaveBeenCalledWith(true);
    expect(mocks.load).not.toHaveBeenCalled();
  });
  it("in demo non legge il repository e non mostra moduli di modifica", async () => {
    mocks.pageViewer.mockResolvedValue(demoViewer);
    const html = renderToStaticMarkup(
      await SourceReviewPage({ params: Promise.resolve({ id: "invented" }) }),
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(html).not.toContain("<form");
    expect(html).toContain("La demo non legge né modifica revisioni reali");
  });
  it("carica la fonte per identificativo con il viewer autenticato e ne rende il contesto", async () => {
    const viewer = { ...demoViewer, demo: false };
    mocks.pageViewer.mockResolvedValue(viewer);
    mocks.load.mockResolvedValue(data());
    const html = renderToStaticMarkup(
      await SourceReviewPage({
        params: Promise.resolve({ id: "invented-publication" }),
      }),
    );
    expect(mocks.load).toHaveBeenCalledWith("invented-publication", viewer);
    expect(html).toContain("Revisione di una fonte inventata");
    expect(html).toContain("Storico privato della fonte");
  });
  it("mostra la pagina non trovata quando il repository restituisce 404", async () => {
    mocks.pageViewer.mockResolvedValue({ ...demoViewer, demo: false });
    mocks.load.mockRejectedValue(new HttpError(404, "Fonte assente"));
    await expect(
      SourceReviewPage({ params: Promise.resolve({ id: "missing" }) }),
    ).rejects.toThrow("not-found");
  });
});
