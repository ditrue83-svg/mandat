import { beforeEach, describe, it, expect, vi } from "vitest";
import type { LotAssessmentInput } from "../src/lib/lot-assessment";
const mock = vi.hoisted(() => ({
  grant: "toy-grant" as string | null,
  queue: [] as unknown[],
  calls: 0,
  usage: 0,
  commits: [] as unknown[],
}));
vi.mock("@/db", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: async () => [],
          then: (resolve: (x: unknown) => void) =>
            resolve([{ id: `toy-usage-${++mock.usage}` }]),
        }),
      }),
    }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({
          returning: async () => [{ id: "toy-run" }],
        }),
        onConflictDoNothing: () => ({
          returning: async () => [{ id: "toy-adoption" }],
        }),
      }),
    }),
    update: () => ({ set: () => ({ where: async () => [] }) }),
  }),
}));
vi.mock("../src/lib/assessment-shape", () => ({
  resolveAssessmentSourceContext: () => ({
    target: {
      kind: "lot",
      publicationId: "toy-publication",
      lotId: "toy-lot",
      sourceProjectId: "toy-project",
    },
    dependency: { publicationId: "toy-publication" },
    projectBarrier: { reason: "not_reviewed" },
    targetContent: {
      identity: { detailUrl: "https://example.invalid/toy" },
      selectedLot: {
        path: "/lots/1",
        record: {
          id: "toy-lot",
          title: { it: "Toy event in Ticino" },
          orderAddress: { countryId: "CH" },
          orderAddressDescription: { it: "Schweiz" },
          orderDescription: { it: "Toy description" },
        },
      },
      projectSections: {
        dates: { offerDeadline: "2030-02-01T23:59:00+01:00" },
        "project-info": {
          offerSpecificNote: {
            it: "L’offerta completa deve essere presentata entro il 1 febbraio 2030.",
          },
          participantLotsLimitationNote: {
            it: "L’offerente ha il diritto di presentare un’offerta per più lotti.",
          },
        },
      },
    },
  }),
}));
vi.mock("../src/lib/operational-reading-runtime", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readOperationalGrant: async (_db: unknown, companyId: string) =>
    companyId === "toy-company" ? mock.grant : null,
}));
vi.mock("../src/worker/ai", () => ({
  infer: async () => {
    mock.calls++;
    if (!mock.queue.length) throw Error("Unexpected toy provider request");
    return mock.queue.shift();
  },
}));
import {
  buildOperationalRuntimePlan,
  readOperationalRuntimeRecord,
  wrapOperationalRecord,
} from "../src/lib/operational-reading-runtime";
import { ensureOperationalReading } from "../src/worker/operational-reading";
const input = {
  companyId: "toy-company",
  publication: { id: "toy-publication" },
  history: [],
} as unknown as LotAssessmentInput;
const target = {
  kind: "lot" as const,
  publicationId: "toy-publication",
  lotId: "toy-lot",
  sourceProjectId: "toy-project",
};
function fixture() {
  const plan = buildOperationalRuntimePlan(input, target),
    p = plan.protocol,
    id = (path: string) => p.catalog.find((p) => p.path === path)!.fieldId;
  const reading = {
    binding: p.binding,
    country: "CH",
    countryEvidence: [id("/lots/1/orderAddress/countryId")],
    canton: null,
    cantonEvidence: [],
    city: null,
    cityEvidence: [],
    deadline: {
      value: "2030-02-01T23:59:00+01:00",
      appliesToTarget: true,
      dateFieldId: id("/dates/offerDeadline"),
      submissionFieldIds: [id("/project-info/offerSpecificNote/it")],
      lotApplicabilityFieldIds: [
        id("/project-info/participantLotsLimitationNote/it"),
      ],
      otherEvidenceFieldIds: [],
    },
    rationale: "Entirely invented fixture",
    issues: [],
  };
  const review = {
    binding: p.binding,
    checks: {
      country: {
        verdict: "supported",
        evidence: reading.countryEvidence,
        rationale: "Toy",
      },
      canton: { verdict: "not_verifiable", evidence: [], rationale: "Toy" },
      city: { verdict: "not_verifiable", evidence: [], rationale: "Toy" },
      deadline: {
        verdict: "supported",
        evidence: [
          reading.deadline.dateFieldId,
          ...reading.deadline.submissionFieldIds,
          ...reading.deadline.lotApplicabilityFieldIds,
        ],
        rationale: "Toy",
      },
    },
    issues: [],
  };
  return { plan, reading, review };
}
const options = () => ({
  beforeRequest: async () => {},
  commitRecord: async (_id: string, result: unknown) => {
    mock.commits.push(result);
  },
  now: () => new Date("2030-01-01T12:00:00Z"),
});
beforeEach(() => {
  Object.assign(process.env, {
    DOCUMENTARY_LLM_PROVIDER: "openai",
    DOCUMENTARY_LLM_MODEL: "gpt-6-luna",
    DOCUMENTARY_LLM_REASONING_EFFORT: "high",
    DOCUMENTARY_LLM_INPUT_CHF_PER_MILLION: ".15",
    DOCUMENTARY_LLM_OUTPUT_CHF_PER_MILLION: ".75",
    OPENAI_API_BASE_URL: "https://api.openai.com/v1",
  });
  mock.grant = "toy-grant";
  mock.queue = [];
  mock.calls = 0;
  mock.usage = 0;
  mock.commits = [];
});
describe("Field-bound runtime with entirely invented sources and in-memory stubs", () => {
  it("links raw reading and review through worker, hashed wrapper and native reader", async () => {
    const f = fixture();
    mock.queue = [f.reading, f.review];
    const result = await ensureOperationalReading(
      input,
      target,
      "toy-match",
      "toy-grant",
      options(),
    );
    expect(result.status).toBe("completed");
    expect(mock.calls).toBe(2);
    expect(mock.commits).toHaveLength(1);
    const record = readOperationalRuntimeRecord(mock.commits[0], f.plan);
    expect(record).not.toBeNull();
    const stored = mock.commits[0] as {
      proofProtocol: { reading: unknown; review: unknown };
    };
    expect(stored.proofProtocol.reading).toEqual(f.reading);
    expect(stored.proofProtocol.review).toEqual(f.review);
  });
  it("rejects unauthorized company key before inference or commit", async () => {
    await expect(
      ensureOperationalReading(
        { ...input, companyId: "another-company" },
        target,
        "toy-match",
        "toy-grant",
        options(),
      ),
    ).rejects.toThrow("permission unavailable");
    expect(mock.calls).toBe(0);
    expect(mock.commits).toHaveLength(0);
  });
  it("rejects revoked grant before inference", async () => {
    mock.grant = null;
    await expect(
      ensureOperationalReading(
        input,
        target,
        "toy-match",
        "toy-grant",
        options(),
      ),
    ).rejects.toThrow("permission unavailable");
    expect(mock.calls).toBe(0);
  });
  it("revocation after reading prevents review and commit", async () => {
    const f = fixture();
    mock.queue = [f.reading, f.review];
    let guards = 0;
    await expect(
      ensureOperationalReading(input, target, "toy-match", "toy-grant", {
        ...options(),
        beforeRequest: async () => {
          if (++guards === 2) mock.grant = null;
        },
      }),
    ).rejects.toThrow();
    expect(mock.calls).toBeLessThanOrEqual(1);
    expect(mock.commits).toHaveLength(0);
  });
  it("invalid reference holds after one reading; no review or repair", async () => {
    const f = fixture();
    f.reading.countryEvidence = ["missing-ref"];
    mock.queue = [f.reading, f.review];
    const result = await ensureOperationalReading(
      input,
      target,
      "toy-match",
      "toy-grant",
      options(),
    );
    expect(result.status).toBe("held");
    expect(mock.calls).toBe(1);
    expect(mock.commits).toHaveLength(0);
  });
  it("review of different evidence holds without committing", async () => {
    const f = fixture();
    f.review.checks.country.evidence = [
      f.plan.protocol.catalog.find((p) => p.path === "/lots/1/title/it")!
        .fieldId,
    ];
    mock.queue = [f.reading, f.review];
    const result = await ensureOperationalReading(
      input,
      target,
      "toy-match",
      "toy-grant",
      options(),
    );
    expect(result.status).toBe("held");
    expect(mock.calls).toBe(2);
    expect(mock.commits).toHaveLength(0);
  });
  it("tampering raw references invalidates stored wrapper even when native record survives", () => {
    const f = fixture(),
      rec = f.plan.protocol.record(f.reading, f.review, {
        id: "toy",
        at: "2030-01-01T12:00:00Z",
        model: "gpt-6-luna",
      }),
      stored = wrapOperationalRecord(rec, f.plan, {
        reading: f.reading,
        review: f.review,
      });
    expect(readOperationalRuntimeRecord(stored, f.plan)).toEqual(rec);
    const changed = structuredClone(stored);
    (changed.proofProtocol.reading as typeof f.reading).countryEvidence = [
      "missing-ref",
    ];
    expect(readOperationalRuntimeRecord(changed, f.plan)).toBeNull();
  });
  it("legacy unbound wrapper cannot be consumed by successor runtime", () => {
    const f = fixture(),
      rec = f.plan.protocol.record(f.reading, f.review, {
        id: "toy",
        at: "2030-01-01T12:00:00Z",
        model: "gpt-6-luna",
      });
    expect(
      readOperationalRuntimeRecord(
        {
          version: "operational-reading-runtime-v1",
          inputHash: f.plan.inputHash,
          configHash: f.plan.configHash,
          requestHash: f.plan.requestHash,
          record: rec,
        },
        f.plan,
      ),
    ).toBeNull();
  });
  it("constructor cannot wrap a record reviewed against different references", () => {
    const f = fixture(),
      rec = f.plan.protocol.record(f.reading, f.review, {
        id: "toy",
        at: "2030-01-01T12:00:00Z",
        model: "gpt-6-luna",
      });
    const different = structuredClone(f.review);
    different.checks.country.evidence = [];
    expect(() =>
      wrapOperationalRecord(rec, f.plan, {
        reading: f.reading,
        review: different,
      }),
    ).toThrow();
  });
});
