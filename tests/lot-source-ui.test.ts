import {
  shapeFixture,
  refusedUiAcquisition,
} from "./helpers/assessment-shape-fixture";
import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preserveSimapLots } from "../src/lib/source-lots";
import {
  captureLotSourceSnapshot,
  createLotSourceReviewRecord,
  resolveLotSourceContext,
  type LotSourceSnapshot,
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "../src/lib/lot-source-context";
import {
  lotSourceEditorData,
  type LotSourceEditorData,
} from "../src/lib/lot-source-editor-data";
import type { LoadedLotSourceReview } from "../src/lib/lot-source-reviews";
import type { SourceScopeReview } from "../src/lib/domain";
import { demoViewer } from "../src/lib/demo";

const mocks = vi.hoisted(() => ({
  pageViewer: vi.fn(),
  requireViewer: vi.fn(),
  load: vi.fn(),
  append: vi.fn(),
  refresh: vi.fn(),
}));
// The optional harness exercises client callbacks/state without a DOM. SSR uses
// real React hooks. Neither mode is a browser hydration or responsive-layout test.
const hooks = vi.hoisted(() => ({
  enabled: false,
  states: [] as unknown[],
  refs: [] as { current: unknown }[],
  stateIndex: 0,
  refIndex: 0,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState(initial: unknown) {
      if (!hooks.enabled) return actual.useState(initial);
      const index = hooks.stateIndex++;
      if (!(index in hooks.states))
        hooks.states[index] =
          typeof initial === "function" ? initial() : initial;
      return [
        hooks.states[index],
        (value: unknown) => {
          hooks.states[index] =
            typeof value === "function" ? value(hooks.states[index]) : value;
        },
      ];
    },
    useRef(initial: unknown) {
      if (!hooks.enabled) return actual.useRef(initial);
      const index = hooks.refIndex++;
      hooks.refs[index] ??= { current: initial };
      return hooks.refs[index];
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  usePathname: () => "/admin/fonti/invented/lotti",
  notFound: () => {
    throw new Error("not-found");
  },
}));
vi.mock("@/lib/viewer", () => ({
  pageViewer: mocks.pageViewer,
  requireViewer: mocks.requireViewer,
  HttpError: class extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));
vi.mock("@/lib/lot-source-reviews", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/lot-source-reviews")>();
  return {
    ...actual,
    loadLotSourceReview: mocks.load,
    appendLotSourceReview: mocks.append,
  };
});
import {
  LotSourceEditor,
  submitLotSourceReview,
} from "../src/components/lot-source-editor";
import LotSourceReviewPage from "../src/app/admin/fonti/[id]/lotti/page";
import { POST } from "../src/app/api/admin/lot-source-reviews/route";
import { HttpError } from "../src/lib/viewer";

const projectId = "11000000-0000-4000-8000-000000000001",
  noticeId = "22000000-0000-4000-8000-000000000002";
const aId = "33000000-0000-4000-8000-000000000003",
  bId = "44000000-0000-4000-8000-000000000004";
const publicationId = `simap-${projectId}`,
  observationId = "55000000-0000-4000-8000-000000000005";
const identity = {
  projectId,
  publicationId: noticeId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${noticeId}`,
};
const project: LotSourceTarget = { kind: "project", publicationId };
const a: LotSourceTarget = {
  kind: "lot",
  publicationId,
  sourceProjectId: projectId,
  lotId: aId,
};
const b: LotSourceTarget = {
  kind: "lot",
  publicationId,
  sourceProjectId: projectId,
  lotId: bId,
};
const aText = "  🌳 SOLO_A <script>testo inventato</script> e\u0301 / é.  ";
const bText = "SOLO_B_TESTO_RISERVATO_AL_LOTTO_B";
const commonText = "Contesto comune inventato dei lotti.";
const viewer = {
  ...demoViewer,
  demo: false,
  admin: true,
  userId: "authenticated-server-founder",
};
const origin = "https://mandat.example.invalid";
function flag(): SourceScopeReview {
  return {
    status: "required",
    kind: "ambiguous",
    token: "private-legacy-token",
    sourceRevision: "source-before",
    updatedAt: "2030-01-01T12:00:00.000Z",
  };
}
function snapshot(
  text = aText,
  sourceScopeReview: SourceScopeReview | null = null,
): LotSourceSnapshot {
  return captureLotSourceSnapshot({
    publicationId,
    observationId,
    sourceScopeReview,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(
        {
          id: noticeId,
          type: "tender",
          procurement: {
            orderDescription: { it: commonText },
            future: { "a/b~c": ["meta inventato"] },
          },
          base: { id: noticeId, projectId, lotsType: "with" },
          lots: [
            {
              id: aId,
              lotNumber: 1,
              title: { it: "Titolo A", de: "Los A" },
              orderDescription: { it: text, fr: "Description inventée A" },
            },
            {
              id: bId,
              lotNumber: 2,
              title: { it: "Titolo B" },
              orderDescription: { it: bText },
            },
          ],
        },
        identity,
      ),
    },
  });
}
function loaded(
  current = snapshot(),
  target: LotSourceTarget = a,
  history: readonly MixedSourceReviewRecord[] = [],
): LoadedLotSourceReview {
  const context = resolveLotSourceContext(current, target, history);
  return {
    publication: {
      id: publicationId,
      title: "Progetto inventato per UI",
      sourceUrl: identity.detailUrl,
      sourceRevision: "source-current",
      contentRevision: "content-current",
      sourceScopeReview: current.sourceScopeReview,
    },
    snapshot: current,
    shapeState: shapeFixture(current),
    history,
    context,
    expected: {
      observationId: current.observationId,
      snapshotHash: current.snapshotHash,
      shapeEpochToken: shapeFixture(current).epochToken,
      selectionHash: context.dependency.selectionHash,
      targetEventId: context.dependency.reviewEventId,
      projectBarrierHash: context.projectBarrier.barrierHash,
    },
  };
}
let eventSequence = 0;
function record(
  current: LotSourceSnapshot,
  target: LotSourceTarget,
  history: readonly MixedSourceReviewRecord[] = [],
) {
  const data = loaded(current, target, history),
    ctx = data.context;
  const path =
    target.kind === "project"
      ? "/procurement/orderDescription/it"
      : `${ctx.targetContent!.selectedLot!.path}/orderDescription/it`;
  const text =
    target.kind === "project"
      ? commonText
      : (
          ctx.targetContent!.selectedLot!.record as {
            orderDescription: { it: string };
          }
        ).orderDescription.it;
  return createLotSourceReviewRecord(
    {
      target,
      expectedSnapshotHash: data.expected.snapshotHash,
      expectedSelectionHash: data.expected.selectionHash,
      expectedTargetEventId: data.expected.targetEventId,
      expectedProjectBarrierHash: data.expected.projectBarrierHash,
      action: "recorded",
      form: target.kind === "project" ? "broad_scope" : "defined_service",
      references: [
        {
          selectionHash: data.expected.selectionHash!,
          rawPath: path,
          startUtf16: 0,
          endUtf16: text.length,
        },
      ],
      actorId: "PRIVATE_ACTOR_NEVER_IN_CLIENT_DTO",
      note: "Nota storica inventata attribuita al target.",
    },
    current,
    history,
    {
      id: `private-event-${++eventSequence}`,
      sourceRevision: "old-source",
      contentRevision: "old-content",
      createdAt: "2030-01-01T12:00:00.000Z",
    },
  );
}
function render(data = lotSourceEditorData(loaded())) {
  return renderToStaticMarkup(createElement(LotSourceEditor, { data }));
}

it("shows title-code differences for the selected source without adding references or changing the CAS data", () => {
  const input = lotSourceEditorData(loaded());
  input.texts.push(
    {
      scope: "lot",
      path: "/lots/a/title/de",
      text: "BKP 241.1 A inventato",
      documentary: true,
    },
    {
      scope: "lot",
      path: "/lots/a/title/fr",
      text: "CFC 281.6 B inventato",
      documentary: true,
    },
  );
  const before = JSON.stringify(input),
    html = render(input);
  expect(html).toContain("Codici diversi nei titoli originali");
  expect(html).toContain("Passaggi selezionati (0)");
  expect(html).toContain('<option value="" selected="">');
  expect(JSON.stringify(input)).toBe(before);
});
function assertPlain(value: unknown) {
  if (value === null || typeof value !== "object") return;
  expect(Object.getPrototypeOf(value)).toBe(
    Array.isArray(value) ? Array.prototype : Object.prototype,
  );
  Object.values(value).forEach(assertPlain);
}
function elements(root: unknown): ReactElement<Record<string, any>>[] {
  const result: ReactElement<Record<string, any>>[] = [];
  Children.forEach(root as ReactNode, (node) => {
    if (isValidElement<Record<string, any>>(node)) {
      result.push(node);
      result.push(...elements(node.props.children));
    }
  });
  return result;
}
async function pageData(input: LoadedLotSourceReview, lot?: string) {
  mocks.pageViewer.mockResolvedValue(viewer);
  mocks.load.mockResolvedValue(input);
  const page = await LotSourceReviewPage({
    params: Promise.resolve({ id: publicationId }),
    searchParams: Promise.resolve(lot ? { lot } : {}),
  });
  const editor = elements(page).find(
    (element) => element.type === LotSourceEditor,
  );
  expect(editor).toBeDefined();
  return {
    page,
    editor: editor!,
    data: editor!.props.data as LotSourceEditorData,
  };
}
function submission() {
  const data = lotSourceEditorData(loaded());
  return {
    data,
    action: "recorded" as const,
    form: "defined_service" as const,
    references: [
      {
        selectionHash: data.expected.selectionHash!,
        rawPath: "/lots/0/orderDescription/it",
        startUtf16: 2,
        endUtf16: aText.length - 2,
      },
    ],
    note: "  Nota inventata per il salvataggio.  ",
    resolveLegacyScope: false,
  };
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/admin/lot-source-reviews`, {
    method: "POST",
    headers: { origin, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
function routeBody() {
  const input = submission(),
    data = input.data;
  return {
    target: data.target,
    expectedObservationId: data.expected.observationId,
    expectedSnapshotHash: data.expected.snapshotHash,
    expectedShapeEpochToken: data.expected.shapeEpochToken,
    expectedSelectionHash: data.expected.selectionHash,
    expectedTargetEventId: data.expected.targetEventId,
    expectedProjectBarrierHash: data.expected.projectBarrierHash,
    action: input.action,
    form: input.form,
    references: input.references,
    note: input.note.trim(),
    resolveLegacyScope: false,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("APP_URL", origin);
  hooks.enabled = false;
  hooks.states = [];
  hooks.refs = [];
  hooks.stateIndex = 0;
  hooks.refIndex = 0;
  mocks.pageViewer.mockResolvedValue(viewer);
  mocks.requireViewer.mockResolvedValue(viewer);
  mocks.append.mockResolvedValue({});
});
afterEach(() => {
  hooks.enabled = false;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("DTO e markup della fonte selezionata", () => {
  it("passes plain client props at the actual child-page boundary, including a null-prototype legacy flag", async () => {
    const legacy = Object.assign(
      Object.create(null),
      flag(),
    ) as SourceScopeReview;
    const input = loaded(snapshot(aText, legacy));
    input.publication.sourceScopeReview = legacy;
    const beforeHash = input.snapshot.snapshotHash;
    const view = await pageData(input, aId);
    assertPlain(view.data);
    expect(view.data.publication.sourceScopeReview).toEqual(legacy);
    expect(view.data.publication.sourceScopeReview).not.toBe(legacy);
    expect(view.data.expected).toEqual(input.expected);
    expect(view.data.target).toEqual(input.context.target);
    expect(input.snapshot.snapshotHash).toBe(beforeHash);
    expect(Object.getPrototypeOf(legacy)).toBeNull();
    expect(view.editor.key).toContain(input.expected.snapshotHash);
    expect(view.editor.key).toContain(aId);
  });
  it("keeps current A/project content separate from B and preserves labelled historical quotes from their own snapshots", () => {
    const old = snapshot("TESTO_STORICO_A"),
      p = record(old, project),
      ar = record(old, a, [p]),
      br = record(old, b, [p, ar]);
    const input = loaded(snapshot("TESTO_CORRENTE_A"), a, [p, ar, br]);
    const data = lotSourceEditorData(input);
    assertPlain(data);
    expect(JSON.stringify(data.texts)).not.toContain(bText);
    expect(data.original).not.toContain(bText);
    expect(data.original).toContain("TESTO_CORRENTE_A");
    expect(data.directory.map((lot) => lot.id)).toEqual([aId, bId]);
    expect(data.history[1].quotes).toEqual(["TESTO_STORICO_A"]);
    expect(data.history[2]).toMatchObject({
      target: `Lotto ${bId}`,
      quotes: [bText],
    });
    expect(input.history[1].snapshot).toEqual(old);
    expect(JSON.stringify(data)).not.toContain(
      "PRIVATE_ACTOR_NEVER_IN_CLIENT_DTO",
    );
    expect(JSON.stringify(data)).not.toContain(ar.event.eventHash);
    const html = render(data);
    expect(html).toContain("TESTO_STORICO_A");
    expect(html).toContain("TESTO_CORRENTE_A");
    expect(html).toContain(`Lotto ${bId}`);
  });
  it("escapes original HTML, preserves full text/Unicode/path and renders the selected navigation and project scope", () => {
    const data = lotSourceEditorData(loaded());
    const html = render(data);
    expect(html).toContain("&lt;script&gt;testo inventato&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("🌳");
    expect(html).toContain("e\u0301 / é.");
    expect(html).toContain("Description inventée A");
    expect(html).toContain("/procurement/future/a~1b~0c/0");
    expect(html).toContain("Contesto del progetto");
    expect(html).toContain(
      "la pertinenza per una ditta richiede una valutazione distinta",
    );
    expect(html).toContain(`?lot=${aId}`);
    expect(html).toContain(`?lot=${bId}`);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain("Usa il passaggio selezionato");
    expect(html).not.toContain(bText);
  });
  it.each([
    "javascript:alert(1)",
    "http://unsafe.example.invalid",
    "https://user:password@example.invalid",
    "data:text/html,x",
    "not a URL",
  ])("does not activate unsafe original URL %s", (sourceUrl) => {
    const data = lotSourceEditorData(loaded());
    data.publication.sourceUrl = sourceUrl;
    const html = render(data);
    expect(html).not.toContain("Apri il portale originale");
    expect(html).not.toContain('class="source-link"');
  });
  it("shows project-only legacy resolution and refuses source recording when no verified input exists", () => {
    const current = snapshot(aText, flag());
    expect(render(lotSourceEditorData(loaded(current, project)))).toContain(
      "confermo la risoluzione",
    );
    expect(render(lotSourceEditorData(loaded(current, a)))).not.toContain(
      "confermo la risoluzione",
    );
    const refused = captureLotSourceSnapshot({
      publicationId,
      observationId,
      sourceScopeReview: null,
      acquisition: refusedUiAcquisition(identity),
    });
    const data = lotSourceEditorData(loaded(refused, project)),
      html = render(data);
    expect(data.texts).toEqual([]);
    expect(data.original).toBeNull();
    expect(html).toContain(
      "L’archivio non consente una revisione verificabile",
    );
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*>Salva revisione della fonte/,
    );
    expect(html).toContain("Apri una verifica");
  });
});

describe("comando client e callback locali", () => {
  it("posts exact source/target CAS and complete references, never an actor or company supplied by the caller", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetcher);
    const input = Object.assign(submission(), {
      actorId: "forged",
      companyId: "foreign",
    });
    expect(await submitLotSourceReview(input)).toMatchObject({
      ok: true,
      stale: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("/api/admin/lot-source-reviews");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual(routeBody());
    expect(JSON.parse(options.body)).not.toHaveProperty("actorId");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("opening a review always clears form/references/legacy-resolution even for refused inputs", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const input = submission();
    input.data.expected.selectionHash = null;
    await submitLotSourceReview({
      ...input,
      action: "opened",
      resolveLegacyScope: true,
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({
      action: "opened",
      form: null,
      references: [],
      resolveLegacyScope: false,
      expectedSelectionHash: null,
    });
  });
  it.each([
    { note: "short" },
    { note: "x".repeat(801) },
    { form: "" as const },
    { references: [] },
  ])("rejects incomplete local input before fetch: %j", async (patch) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await submitLotSourceReview({ ...submission(), ...patch }),
    ).toMatchObject({ ok: false, stale: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([400, 403, 409, 500])(
    "does not turn HTTP %s into success or retry",
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal("fetch", fetcher);
      expect(await submitLotSourceReview(submission())).toMatchObject({
        ok: false,
        stale: status === 409,
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );
  it.each(["uncertain", "stale", "success"])(
    "client callbacks prevent a second write while busy and after %s",
    async (outcome) => {
      let complete!: (value: Response) => void,
        reject!: (reason: Error) => void;
      const fetcher = vi.fn(
        () =>
          new Promise<Response>((resolve, fail) => {
            complete = resolve;
            reject = fail;
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      hooks.enabled = true;
      const data = lotSourceEditorData(loaded());
      const tree = () => {
        hooks.stateIndex = 0;
        hooks.refIndex = 0;
        return LotSourceEditor({ data });
      };
      let current = tree();
      const note = elements(current).find(
        (e) => e.type === "textarea" && e.props.minLength === 10,
      )!;
      note.props.onChange({
        target: { value: "Nota inventata sufficientemente lunga." },
      });
      current = tree();
      const openButton = () =>
        elements(tree()).find(
          (e) =>
            e.type === "button" && e.props.children === "Apri una verifica",
        )!;
      const initial = openButton();
      initial.props.onClick();
      initial.props.onClick();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(openButton().props.disabled).toBe(true);
      if (outcome === "uncertain")
        reject(new Error("PRIVATE_TRANSPORT_DETAIL"));
      else
        complete(
          new Response(null, { status: outcome === "stale" ? 409 : 200 }),
        );
      await vi.waitFor(() => {
        const status = elements(tree()).find((e) => e.props.role === "status");
        expect(status).toBeDefined();
        expect(String(status!.props.children)).not.toContain(
          "PRIVATE_TRANSPORT_DETAIL",
        );
        expect(openButton().props.disabled).toBe(true);
      });
      openButton().props.onClick();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(mocks.refresh).toHaveBeenCalledTimes(
        outcome === "success" ? 1 : 0,
      );
      if (outcome === "uncertain")
        expect(
          elements(tree()).some(
            (e) =>
              e.props.role === "status" &&
              String(e.props.children).includes(
                "verificare se il salvataggio è riuscito",
              ),
          ),
        ).toBe(true);
    },
  );
});

describe("pagina e route autenticate", () => {
  it("requires the founder before loading and shows no read/edit path in demo", async () => {
    mocks.pageViewer.mockRejectedValueOnce(new Error("redirect-to-access"));
    await expect(
      LotSourceReviewPage({
        params: Promise.resolve({ id: publicationId }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("redirect-to-access");
    expect(mocks.pageViewer).toHaveBeenCalledWith(true);
    expect(mocks.load).not.toHaveBeenCalled();
    mocks.pageViewer.mockResolvedValueOnce(demoViewer);
    const html = renderToStaticMarkup(
      await LotSourceReviewPage({
        params: Promise.resolve({ id: publicationId }),
        searchParams: Promise.resolve({ lot: aId }),
      }),
    );
    expect(mocks.load).not.toHaveBeenCalled();
    expect(html).not.toContain("<form");
    expect(html).toContain("La demo non legge né modifica revisioni reali");
  });
  it("derives project/lot identity from page parameters, keeps CAS in the component key, and maps only 404 to notFound", async () => {
    const input = loaded();
    const { page } = await pageData(input, aId);
    expect(mocks.load).toHaveBeenCalledWith(a, viewer);
    expect(renderToStaticMarkup(page)).toContain("Progetto inventato per UI");
    await pageData(loaded(snapshot(), project));
    expect(mocks.load).toHaveBeenLastCalledWith(project, viewer);
    mocks.load.mockRejectedValueOnce(new HttpError(404, "Missing"));
    await expect(
      LotSourceReviewPage({
        params: Promise.resolve({ id: publicationId }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("not-found");
    mocks.load.mockRejectedValueOnce(new HttpError(409, "Stale"));
    await expect(
      LotSourceReviewPage({
        params: Promise.resolve({ id: publicationId }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each(["https://other.example.invalid", ""])(
    "checks origin %j before authentication or any write",
    async (requestOrigin) => {
      const response = await POST(
        request(routeBody(), { origin: requestOrigin }),
      );
      expect(response.status).toBe(403);
      expect(mocks.requireViewer).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );
  it.each(["access denied", "demo mutation denied"])(
    "does not write after the authenticated viewer boundary rejects %s",
    async (message) => {
      mocks.requireViewer.mockRejectedValueOnce(new HttpError(403, message));
      const response = await POST(request(routeBody()));
      expect(response.status).toBe(403);
      expect(mocks.requireViewer).toHaveBeenCalledWith({
        admin: true,
        mutation: true,
      });
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );
  it("validates the body, forbids a JSON actor and returns success only after repository completion", async () => {
    expect(
      (await POST(request({ ...routeBody(), actorId: "forged" }))).status,
    ).toBe(400);
    expect(mocks.append).not.toHaveBeenCalled();
    mocks.append.mockRejectedValueOnce(
      new HttpError(409, "Current state changed"),
    );
    const stale = await POST(request(routeBody()));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "Current state changed" });
    mocks.append.mockClear();
    const ok = await POST(request(routeBody()));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledWith(routeBody(), viewer);
  });
});

it("shows the real whole project and its shared conditions without inventing a lot", () => {
  const snap = captureLotSourceSnapshot({
    publicationId,
    observationId,
    sourceScopeReview: null,
    acquisition: {
      state: "accepted",
      archive: preserveSimapLots(
        {
          id: noticeId,
          type: "tender",
          base: { id: noticeId, projectId, lotsType: "without", lots: [] },
          lots: [],
          procurement: {
            orderDescription: {
              it: "Potatura inventata per l'intero progetto.",
            },
            partialOffers: { it: "CONDIZIONE_SENZA_LOTTI: offerta intera." },
          },
        },
        identity,
      ),
    },
  });
  const data = lotSourceEditorData(loaded(snap, project));
  const html = render(data);
  expect(data.shape).toMatchObject({
    kind: "project",
    epochToken: expect.any(String),
  });
  expect(data.directory).toEqual([]);
  expect(
    data.texts.some(
      (t) =>
        t.path === "/procurement/partialOffers/it" &&
        t.text.includes("CONDIZIONE_SENZA_LOTTI"),
    ),
  ).toBe(true);
  expect(html).toContain("Intero progetto — gara senza lotti");
  expect(html).toContain("CONDIZIONE_SENZA_LOTTI");
  expect(html).not.toContain("Lotto null");
  expect(data.expected.shapeEpochToken).toBe(data.shape.epochToken);
});
