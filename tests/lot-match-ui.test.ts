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
  type LotSourceTarget,
  type MixedSourceReviewRecord,
} from "../src/lib/lot-source-context";
import {
  createHumanLotAssessment,
  lotAssessmentProfileHash,
  lotEvaluationSetToken,
  resolveProjectLotAssessment,
  type LotAssessmentInput,
  type LotAssessmentResult,
  type LotAssessmentTarget,
} from "../src/lib/lot-assessment";
import { preliminaryLotMatch } from "../src/lib/lot-matching";
import {
  lotMatchEditorData,
  type LotMatchEditorData,
} from "../src/lib/lot-match-editor-data";
import type {
  CompanyProfile,
  Publication,
  SourceScopeReview,
} from "../src/lib/domain";
import { demoViewer } from "../src/lib/demo";

const mocks = vi.hoisted(() => ({
  pageViewer: vi.fn(),
  requireViewer: vi.fn(),
  load: vi.fn(),
  append: vi.fn(),
  refresh: vi.fn(),
}));
// Callback state harness plus real SSR. This is not a browser/Flight test.
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
      const i = hooks.stateIndex++;
      if (!(i in hooks.states))
        hooks.states[i] = typeof initial === "function" ? initial() : initial;
      return [
        hooks.states[i],
        (v: unknown) => {
          hooks.states[i] = typeof v === "function" ? v(hooks.states[i]) : v;
        },
      ];
    },
    useRef(initial: unknown) {
      if (!hooks.enabled) return actual.useRef(initial);
      const i = hooks.refIndex++;
      hooks.refs[i] ??= { current: initial };
      return hooks.refs[i];
    },
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
  usePathname: () => "/admin/valutazioni/company/invented",
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
vi.mock("@/lib/lot-match-reviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/lot-match-reviews")>()),
  loadLotMatchReview: mocks.load,
  appendLotMatchReview: mocks.append,
}));
import {
  lotMatchReviewTarget,
  type LoadedLotMatchReview,
} from "../src/lib/lot-match-reviews";
import {
  LotMatchEditor,
  submitLotMatchReview,
} from "../src/components/lot-match-editor";
import { OriginalText } from "../src/components/lot-source-editor";
import Page from "../src/app/admin/valutazioni/[companyId]/[publicationId]/page";
import { POST } from "../src/app/api/admin/lot-match-reviews/route";
import { HttpError } from "../src/lib/viewer";

const projectId = "11000000-0000-4000-8000-000000000001",
  noticeId = "22000000-0000-4000-8000-000000000002";
const aId = "33000000-0000-4000-8000-000000000003",
  bId = "44000000-0000-4000-8000-000000000004";
const publicationId = `simap-${projectId}`,
  companyId = "invented-company";
const identity = {
  projectId,
  publicationId: noticeId,
  detailUrl: `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${noticeId}`,
};
const a: LotAssessmentTarget = {
  kind: "lot",
  publicationId,
  sourceProjectId: projectId,
  lotId: aId,
};
const b: LotAssessmentTarget = { ...a, lotId: bId };
const project: LotSourceTarget = { kind: "project", publicationId };
const commonText = "Contesto comune inventato, lotti distinti.";
const aText = '  🌳 Potatura SOLO_A <img src=x onerror="alert(1)"> e\u0301.  ';
const bText = "SOLO_B: installazione di quadri elettrici.";
const now = new Date("2026-01-02T10:00:00.000Z");
const viewer = {
  ...demoViewer,
  admin: true,
  demo: false,
  userId: "SERVER_ACTOR_PRIVATE",
};
const origin = "https://mandat.example.invalid";
const h = (character: string) => character.repeat(64);
function fixture(
  options: { blocked?: boolean; refused?: boolean } = {},
): LoadedLotMatchReview {
  const flag: SourceScopeReview | null = options.blocked
    ? {
        status: "required",
        kind: "ambiguous",
        token: "legacy-private",
        sourceRevision: "before",
        updatedAt: now.toISOString(),
      }
    : null;
  const snap = captureLotSourceSnapshot({
    publicationId,
    observationId: "observation-invented",
    sourceScopeReview: flag,
    acquisition: options.refused
      ? {
          state: "refused",
          identity,
          reason: "archive-refused",
          receiptHash: h("c"),
        }
      : {
          state: "accepted",
          archive: preserveSimapLots(
            {
              id: noticeId,
              base: { id: noticeId, projectId, lotsType: "with" },
              procurement: {
                orderDescription: { it: commonText },
                extra: { "a/b~c": "METADATO ORIGINALE" },
              },
              lots: [
                {
                  id: aId,
                  lotNumber: 1,
                  title: { it: "Potatura", de: "Baumpflege" },
                  orderDescription: {
                    it: aText,
                    fr: "Texte original français A",
                  },
                  orderAddress: {
                    countryId: "CH",
                    cantonId: "TI",
                    city: "Lugano",
                  },
                },
                {
                  id: bId,
                  lotNumber: 2,
                  title: { it: "Impianti" },
                  orderDescription: { it: bText },
                },
              ],
            },
            identity,
          ),
        },
  });
  const history: MixedSourceReviewRecord[] = [];
  if (!options.blocked && !options.refused)
    for (const target of [project, a, b]) {
      const context = resolveLotSourceContext(snap, target, history);
      const path =
        target.kind === "project"
          ? "/procurement/orderDescription/it"
          : `/lots/${target.lotId === aId ? 0 : 1}/orderDescription/it`;
      const quote =
        target.kind === "project"
          ? commonText
          : target.lotId === aId
            ? aText
            : bText;
      history.push(
        createLotSourceReviewRecord(
          {
            target,
            expectedSnapshotHash: snap.snapshotHash,
            expectedSelectionHash: context.dependency.selectionHash,
            expectedTargetEventId: context.dependency.reviewEventId,
            expectedProjectBarrierHash: context.projectBarrier.barrierHash,
            action: "recorded",
            form: target.kind === "project" ? "broad_scope" : "defined_service",
            references: [
              {
                selectionHash: context.dependency.selectionHash!,
                rawPath: path,
                startUtf16: 0,
                endUtf16: quote.length,
              },
            ],
            actorId: "SOURCE_ACTOR_PRIVATE",
            note: "PRIVATE_SOURCE_NOTE",
          },
          snap,
          history,
          {
            id: `source-${history.length}`,
            sourceRevision: "source-revision",
            contentRevision: "content-revision",
            createdAt: now.toISOString(),
          },
        ),
      );
    }
  const profile: CompanyProfile = {
    name: "Ditta inventata",
    activities: "Potatura e cura del verde.",
    employees: 2,
    sectors: ["giardinaggio"],
    zones: ["Tutto il Ticino"],
    keywords: ["potatura"],
    exclusions: [],
    minValue: null,
    maxValue: null,
    emailEnabled: true,
  };
  const publication: Publication = {
    id: publicationId,
    source: "simap",
    externalId: projectId,
    projectId,
    title: "Progetto inventato a lotti",
    buyer: "Ente inventato",
    location: "Lugano",
    canton: "TI",
    zone: "Luganese",
    publishedAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-01-01T08:00:00.000Z",
    visibleAt: "2026-01-01T07:00:00.000Z",
    deadline: null,
    valueChf: null,
    procedure: "open",
    status: "open",
    sectors: ["giardinaggio"],
    cpv: [],
    sourceUrl: identity.detailUrl,
    sourceUrls: [identity.detailUrl],
    originalText: commonText,
    summary: null,
    requirements: [],
    evidence: [],
    documents: [],
    reviewRequired: false,
    reviewReasons: [],
    revision: "publication-revision",
    sourceScopeReview: flag ?? undefined,
  };
  const input: LotAssessmentInput = {
    companyId,
    publication,
    profile,
    snapshot: snap,
    history,
    evaluationSet: null,
    now,
  };
  const resolved = resolveProjectLotAssessment(input);
  // Only irrelevant persistence-row metadata is stubbed: document context,
  // operational filter, dependencies, profiles and project resolution are real.
  return {
    match: {
      id: "match-invented",
      companyId,
      publicationId,
      ownerId: "NEVER_OWNER",
    },
    company: {
      id: companyId,
      ownerId: "NEVER_OWNER",
      profile,
      disabledAt: null,
      createdAt: now,
      onboardedAt: now,
    },
    publication: {
      id: publicationId,
      data: publication,
      canonicalId: "canonical-invented",
    },
    input,
    project: resolved,
    state: { evaluations: null, suppression: null },
    history: [],
    group: {
      key: "private-key",
      state: null,
      token: h("e"),
      before: { members: [publicationId], legacy: [], state: null },
      suppression: null,
    },
    expected: {
      snapshotHash: snap.snapshotHash,
      profileHash: lotAssessmentProfileHash(profile),
      stateToken: h("a"),
      groupToken: h("e"),
      evaluationSetToken: lotEvaluationSetToken(null, companyId, publicationId),
      projectBindingHash: resolved.projectBindingHash,
    },
  } as unknown as LoadedLotMatchReview;
}
function dto(input = fixture(), lot: string | null = aId) {
  return lotMatchEditorData(
    input,
    lot ? lotMatchReviewTarget(input, lot) : null,
  );
}
function addHistory(
  input: LoadedLotMatchReview,
  target: LotAssessmentTarget,
  result: LotAssessmentResult = "review",
) {
  const selected = lotMatchReviewTarget(input, target.lotId);
  const text = target.lotId === aId ? aText : bText;
  const path = `/lots/${target.lotId === aId ? 0 : 1}/orderDescription/it`;
  const id = `assessment-${target.lotId}-${input.history.length}`;
  const outcome = createHumanLotAssessment(
    {
      target,
      expectedSnapshotHash: input.expected.snapshotHash,
      expectedSourceDependency: selected.context.dependency,
      expectedProfileHash: input.expected.profileHash,
      expectedOperationalInputHash: preliminaryLotMatch({
        publication: input.input.publication,
        profile: input.input.profile,
        context: selected.context,
        now,
      }).operationalInputHash,
      expectedEvaluationSetToken: input.expected.evaluationSetToken,
      expectedEntryHash: selected.expected.entryHash,
      result,
      reason: "Motivo storico inventato per la ditta.",
      references: [
        {
          selectionHash: selected.context.dependency.selectionHash!,
          rawPath: path,
          startUtf16: 2,
          endUtf16: text.length - 2,
        },
      ],
      origin: "human",
      confirmedReviewReasons: [],
    },
    input.input,
    {
      id,
      actorId: "ASSESSMENT_ACTOR_PRIVATE",
      at: now.toISOString(),
      note: "NOTA_PRIVATA_STORICA",
    },
  );
  const before = input.state;
  input.state = { ...before, evaluations: outcome.evaluationSet };
  input.input = {
    ...input.input,
    evaluationSet: outcome.evaluationSet,
    evidenceSnapshots: [input.input.snapshot],
  };
  input.project = resolveProjectLotAssessment(input.input);
  input.expected.evaluationSetToken = lotEvaluationSetToken(
    outcome.evaluationSet,
    companyId,
    publicationId,
  );
  input.history.push({
    version: "human-lot-match-review-v1",
    id,
    matchId: input.match.id,
    companyId,
    publicationId,
    sequence: input.history.length + 1,
    action: "assess_lot",
    actorId: "ASSESSMENT_ACTOR_PRIVATE",
    at: now.toISOString(),
    note: "NOTA_PRIVATA_STORICA",
    sourceSnapshotHash: input.input.snapshot.snapshotHash,
    evidenceSnapshot: input.input.snapshot,
    profileHash: input.expected.profileHash,
    groupBefore: input.group.before,
    groupAfter: null,
    before,
    after: input.state,
    previousToken: h("a"),
    nextToken: h("b"),
  });
}
function assertPlain(value: unknown) {
  if (!value || typeof value !== "object") return;
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
function submission() {
  const data = dto();
  return {
    data,
    action: "assess_lot" as const,
    result: "direct" as const,
    reason: "  La potatura del lotto riguarda le attività della ditta.  ",
    note: "  Nota privata inventata per il fondatore.  ",
    references: [
      {
        selectionHash: data.selected!.expected.sourceDependency.selectionHash!,
        rawPath: "/lots/0/orderDescription/it",
        startUtf16: 2,
        endUtf16: aText.length - 2,
      },
    ],
    confirmedReviewReasons: [...data.selected!.reviewReasons],
    confirmedProjectAction: false,
  };
}
function request(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/admin/lot-match-reviews`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function body() {
  const fetcher = vi
    .fn()
    .mockResolvedValue(new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  await submitLotMatchReview(submission());
  return JSON.parse(fetcher.mock.calls[0][1].body);
}
const pageProps = (lot?: string) => ({
  params: Promise.resolve({ companyId, publicationId }),
  searchParams: Promise.resolve(lot ? { lot } : {}),
});
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

describe("DTO e rendering della valutazione umana", () => {
  it("passes only plain copies through the actual page, including null-prototype profile/dependency inputs", async () => {
    const input = fixture();
    input.company.profile = Object.assign(
      Object.create(null),
      input.company.profile,
    );
    mocks.load.mockResolvedValue(input);
    const page = await Page(pageProps(aId));
    const editor = elements(page).find((e) => e.type === LotMatchEditor)!;
    assertPlain(editor.props.data);
    expect(mocks.load).toHaveBeenCalledWith(companyId, publicationId, viewer);
    expect(String(editor.key)).toContain(input.expected.groupToken);
    expect(String(editor.key)).toContain(input.expected.profileHash);
    const serialized = JSON.stringify(editor.props.data);
    for (const secret of [
      "NEVER_OWNER",
      "SERVER_ACTOR_PRIVATE",
      "SOURCE_ACTOR_PRIVATE",
      "PRIVATE_SOURCE_NOTE",
      "private-key",
      "emailEnabled",
    ])
      expect(serialized).not.toContain(secret);
    editor.props.data.company.profile.zones.push("mutazione DTO");
    expect(input.company.profile.zones).toEqual(["Tutto il Ticino"]);
    expect(editor.props.data.expected.snapshotHash).toBe(
      input.input.snapshot.snapshotHash,
    );
  });
  it("preserves all selected texts, language fields and escaped paths without lot B source text", () => {
    const data = dto();
    assertPlain(data);
    expect(
      data.selected!.texts.find((e) => e.path === "/lots/0/orderDescription/it")
        ?.text,
    ).toBe(aText);
    expect(
      data.selected!.texts.find((e) => e.path === "/procurement/extra/a~1b~0c")
        ?.text,
    ).toBe("METADATO ORIGINALE");
    expect(data.selected!.texts.map((e) => e.text)).toContain(
      "Texte original français A",
    );
    expect(data.selected!.original).not.toContain(bText);
    expect(JSON.stringify(data.selected)).not.toContain(bText);
    const html = renderToStaticMarkup(createElement(LotMatchEditor, { data }));
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("Nota privata della revisione");
    expect(html).toContain("Motivo visibile alla ditta");
    expect(html).toContain("Lotto 2");
    expect(html).not.toContain(bText);
    expect(html).toContain("non attesta l’idoneità");
  });
  it("keeps exact historical quotes/private notes with the selected lot, omits actors and other-lot history", () => {
    const input = fixture();
    addHistory(input, a);
    addHistory(input, b);
    const data = dto(input);
    expect(data.history).toHaveLength(1);
    expect(data.history[0].quotes).toEqual([aText.slice(2, -2)]);
    expect(data.history[0].note).toBe("NOTA_PRIVATA_STORICA");
    expect(JSON.stringify(data)).not.toContain("ASSESSMENT_ACTOR_PRIVATE");
    expect(JSON.stringify(data)).not.toContain(bText.slice(2, -2));
    expect(dto(input, null).history).toHaveLength(2);
  });
  it("does not present a stale historical judgment as a current result", () => {
    const input = fixture();
    addHistory(input, a);
    input.input = {
      ...input.input,
      profile: {
        ...input.input.profile,
        activities: "Altre attività dichiarate.",
      },
    };
    input.company.profile = input.input.profile;
    input.project = resolveProjectLotAssessment(input.input);
    const data = dto(input, null);
    expect(data.lots[0]).toMatchObject({
      state: "stale",
      result: null,
      reason: null,
    });
    expect(
      renderToStaticMarkup(createElement(LotMatchEditor, { data })),
    ).toContain("Giudizio precedente da aggiornare");
    expect(data.history[0].quotes[0]).toBe(aText.slice(2, -2));
  });
  it("makes legacy source barriers and project veto explicit without enabling certain verdicts", () => {
    const data = dto(fixture({ blocked: true }));
    data.project.suppressed = true;
    data.project.dismissed = true;
    const html = renderToStaticMarkup(createElement(LotMatchEditor, { data }));
    expect(data.selected!.allowsCertainty).toBe(false);
    expect(html).toMatch(/<option value="direct" disabled=""/);
    expect(html).toMatch(/<option value="different" disabled=""/);
    expect(html).toContain("Esamina la fonte del progetto");
    expect(html).toContain("Esamina la fonte del lotto");
    expect(html).toContain("Riconsidera progetto");
    expect(html).toContain("non cambia questa scelta");
    expect(html).toContain("Non approva lotti");
  });
  it("refused archive and removed lot have no assessment content or active assessment button", () => {
    for (const data of [
      dto(fixture({ refused: true })),
      dto(fixture(), "66000000-0000-4000-8000-000000000006"),
    ]) {
      expect(data.selected!.canAssess).toBe(false);
      expect(data.selected!.texts).toEqual([]);
      expect(data.selected!.original).toBeNull();
      const html = renderToStaticMarkup(
        createElement(LotMatchEditor, { data }),
      );
      expect(html).toContain('disabled="">Salva valutazione del lotto');
    }
  });
  it.each([
    "javascript:alert(1)",
    "http://example.invalid",
    "https://user:pass@example.invalid",
    "data:text/html,unsafe",
  ])("never renders unsafe original URL %s", (url) => {
    const data = dto();
    data.publication.sourceUrl = url;
    expect(
      renderToStaticMarkup(createElement(LotMatchEditor, { data })),
    ).not.toContain("Apri il portale originale");
  });
});

describe("invii e conferme del giudizio", () => {
  it("sends all exact current CAS tokens, ordered confirmations and only selected refs, never a client actor", async () => {
    const input = submission();
    const data = input.data;
    input.confirmedReviewReasons.reverse();
    Object.assign(input, { actorId: "FORGED", companyId: "FOREIGN" });
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(await submitLotMatchReview(input)).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe("/api/admin/lot-match-reviews");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      companyId,
      publicationId,
      action: "assess_lot",
      target: a,
      expectedSnapshotHash: data.expected.snapshotHash,
      expectedProfileHash: data.expected.profileHash,
      expectedStateToken: data.expected.stateToken,
      expectedGroupToken: data.expected.groupToken,
      expectedSourceDependency: data.selected!.expected.sourceDependency,
      expectedOperationalInputHash:
        data.selected!.expected.operationalInputHash,
      expectedEvaluationSetToken: data.selected!.expected.evaluationSetToken,
      expectedEntryHash: null,
      result: "direct",
      reason: input.reason.trim(),
      note: input.note.trim(),
      references: input.references,
      confirmedReviewReasons: data.selected!.reviewReasons,
    });
  });
  it("requires every operational warning independently, while review neither approves nor confirms it", async () => {
    const input = submission();
    expect(input.data.selected!.reviewReasons.length).toBeGreaterThan(0);
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    expect(
      await submitLotMatchReview({ ...input, confirmedReviewReasons: [] }),
    ).toMatchObject({ ok: false });
    expect(fetcher).not.toHaveBeenCalled();
    await submitLotMatchReview({
      ...input,
      result: "review",
      confirmedReviewReasons: [],
    });
    expect(
      JSON.parse(fetcher.mock.calls[0][1].body).confirmedReviewReasons,
    ).toEqual([]);
  });
  it.each([
    "missing-note",
    "missing-reason",
    "missing-result",
    "missing-reference",
    "foreign-reference",
    "unreviewed-source",
    "operational-exclusion",
    "no-lot-evidence",
    "refused",
  ])("refuses %s before any POST", async (kind) => {
    const input: Parameters<typeof submitLotMatchReview>[0] = submission();
    if (kind === "missing-note") input.note = "short";
    if (kind === "missing-reason") input.reason = "short";
    if (kind === "missing-result") input.result = "";
    if (kind === "missing-reference") input.references = [];
    if (kind === "foreign-reference")
      input.references[0].rawPath = "/lots/1/orderDescription/it";
    if (kind === "unreviewed-source")
      input.data.selected!.allowsCertainty = false;
    if (kind === "operational-exclusion") input.data.selected!.eligible = false;
    if (kind === "no-lot-evidence")
      input.references = [
        {
          selectionHash: input.references[0].selectionHash,
          rawPath: "/procurement/orderDescription/it",
          startUtf16: 0,
          endUtf16: commonText.length,
        },
      ];
    if (kind === "refused") input.data.selected!.canAssess = false;
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await submitLotMatchReview(input)).toMatchObject({
      ok: false,
      stale: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each(["veto_project", "reopen_project"] as const)(
    "%s requires explicit consent and sends only project CAS, never approvals",
    async (action) => {
      const input = submission();
      input.data.project.suppressed = action === "reopen_project";
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetcher);
      expect(await submitLotMatchReview({ ...input, action })).toMatchObject({
        ok: false,
      });
      expect(fetcher).not.toHaveBeenCalled();
      await submitLotMatchReview({
        ...input,
        action,
        confirmedProjectAction: true,
      });
      const sent = JSON.parse(fetcher.mock.calls[0][1].body);
      expect(sent).toEqual({
        companyId,
        publicationId,
        action,
        expectedSnapshotHash: input.data.expected.snapshotHash,
        expectedProfileHash: input.data.expected.profileHash,
        expectedStateToken: input.data.expected.stateToken,
        expectedGroupToken: input.data.expected.groupToken,
        expectedProjectBindingHash: input.data.expected.projectBindingHash,
        note: input.note.trim(),
      });
    },
  );
  it.each([400, 403, 409, 500])(
    "HTTP %s cannot become success and is not retried",
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
      vi.stubGlobal("fetch", fetcher);
      expect(await submitLotMatchReview(submission())).toMatchObject({
        ok: false,
        stale: status === 409,
      });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(mocks.refresh).not.toHaveBeenCalled();
    },
  );
  it.each(["uncertain", "stale", "success"])(
    "blocks double submit while busy and after %s",
    async (outcome) => {
      let complete!: (value: Response) => void, fail!: (error: Error) => void;
      const fetcher = vi.fn(
        () =>
          new Promise<Response>((resolve, reject) => {
            complete = resolve;
            fail = reject;
          }),
      );
      vi.stubGlobal("fetch", fetcher);
      hooks.enabled = true;
      const data = dto(fixture(), null);
      const tree = () => {
        hooks.stateIndex = 0;
        hooks.refIndex = 0;
        return LotMatchEditor({ data });
      };
      let nodes = elements(tree());
      nodes
        .find((e) => e.type === "textarea" && e.props.maxLength === 800)!
        .props.onChange({
          target: { value: "Nota privata inventata per il progetto." },
        });
      nodes
        .find((e) => e.type === "input" && e.props.type === "checkbox")!
        .props.onChange({ target: { checked: true } });
      const button = () =>
        elements(tree()).find(
          (e) => e.type === "button" && e.props.children === "Escludi progetto",
        )!;
      const initial = button();
      initial.props.onClick();
      initial.props.onClick();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(button().props.disabled).toBe(true);
      if (outcome === "uncertain") fail(new Error("PRIVATE_TRANSPORT_ERROR"));
      else
        complete(
          new Response(null, { status: outcome === "stale" ? 409 : 200 }),
        );
      await vi.waitFor(() => {
        const status = elements(tree()).find((e) => e.props.role === "status");
        expect(status).toBeDefined();
        expect(String(status!.props.children)).not.toContain(
          "PRIVATE_TRANSPORT_ERROR",
        );
        expect(button().props.disabled).toBe(true);
      });
      button().props.onClick();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(mocks.refresh).toHaveBeenCalledTimes(
        outcome === "success" ? 1 : 0,
      );
    },
  );
  it("adds and removes exact original references without deriving a source verdict", () => {
    hooks.enabled = true;
    const data = dto();
    const tree = () => {
      hooks.stateIndex = 0;
      hooks.refIndex = 0;
      return LotMatchEditor({ data });
    };
    const selector = elements(tree()).find(
      (e) =>
        e.type === OriginalText &&
        e.props.entry.path === "/lots/0/orderDescription/it",
    )!;
    const reference = submission().references[0];
    selector.props.onSelect(reference);
    selector.props.onSelect(reference);
    let nodes = elements(tree());
    expect(nodes.find((e) => e.type === "blockquote")!.props.children).toBe(
      aText.slice(2, -2),
    );
    const remove = nodes.filter(
      (e) =>
        e.type === "button" &&
        Array.isArray(e.props.children) &&
        e.props.children[0] === "Rimuovi passaggio ",
    );
    expect(remove).toHaveLength(1);
    remove[0].props.onClick();
    nodes = elements(tree());
    expect(nodes.some((e) => e.type === "blockquote")).toBe(false);
  });
});

describe("pagina e route riservate", () => {
  it("authenticates before reading and demo has no load/editor", async () => {
    mocks.pageViewer.mockRejectedValueOnce(new Error("redirect"));
    await expect(Page(pageProps())).rejects.toThrow("redirect");
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.pageViewer).toHaveBeenCalledWith(true);
    mocks.pageViewer.mockResolvedValueOnce(demoViewer);
    const page = await Page(pageProps(aId));
    expect(mocks.load).not.toHaveBeenCalled();
    expect(elements(page).some((e) => e.type === LotMatchEditor)).toBe(false);
    expect(renderToStaticMarkup(page)).toContain(
      "La demo non legge né modifica valutazioni reali",
    );
  });
  it("loads only requested identities and maps only 404 to notFound", async () => {
    mocks.load.mockResolvedValueOnce(fixture());
    const page = await Page(pageProps());
    expect(mocks.load).toHaveBeenCalledWith(companyId, publicationId, viewer);
    expect(
      elements(page).find((e) => e.type === LotMatchEditor)!.props.data
        .selected,
    ).toBeNull();
    mocks.load.mockRejectedValueOnce(new HttpError(404, "missing"));
    await expect(Page(pageProps())).rejects.toThrow("not-found");
    mocks.load.mockRejectedValueOnce(new HttpError(409, "stale"));
    await expect(Page(pageProps())).rejects.toMatchObject({ status: 409 });
  });
  it.each(["https://other.example.invalid", ""])(
    "checks origin %j before authentication/write",
    async (value) => {
      const response = await POST(request(await body(), value));
      expect(response.status).toBe(403);
      expect(mocks.requireViewer).not.toHaveBeenCalled();
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );
  it.each(["anonymous", "demo"])(
    "does not write after %s viewer rejection",
    async (kind) => {
      mocks.requireViewer.mockRejectedValueOnce(new HttpError(403, kind));
      expect((await POST(request(await body()))).status).toBe(403);
      expect(mocks.requireViewer).toHaveBeenCalledWith({
        admin: true,
        mutation: true,
      });
      expect(mocks.append).not.toHaveBeenCalled();
    },
  );
  it("forbids actor injection, preserves CAS conflicts and succeeds only after the server append", async () => {
    const draft = await body();
    expect((await POST(request({ ...draft, actorId: "forged" }))).status).toBe(
      400,
    );
    expect(mocks.append).not.toHaveBeenCalled();
    const missing = { ...draft };
    delete missing.expectedGroupToken;
    expect((await POST(request(missing))).status).toBe(400);
    expect(mocks.append).not.toHaveBeenCalled();
    mocks.append.mockRejectedValueOnce(new HttpError(409, "current changed"));
    const conflict = await POST(request(draft));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "current changed" });
    mocks.append.mockClear();
    const response = await POST(request(draft));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.append).toHaveBeenCalledOnce();
    expect(mocks.append).toHaveBeenCalledWith(draft, viewer);
  });
});
