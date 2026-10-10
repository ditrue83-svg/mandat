import { describe, it, expect } from "vitest";
import * as native from "../src/lib/lot-operational-evidence";
import { createFieldBoundProtocol } from "../src/lib/field-bound-protocol.mjs";
import type { LotSourceContext } from "../src/lib/lot-source-context";
const clauses = {
  de: "Die Anbieter können sich auf eines oder mehrere Lose bewerben. Die Bewertung erfolgt separat pro Los.",
  fr: "Les soumissionnaires peuvent présenter une offre pour un ou plusieurs lots. L’évaluation se fera par lot.",
  it: "Gli offerenti possono candidarsi per un solo lotto o per più lotti. La valutazione avviene separatamente per ogni lotto.",
  en: null,
};
type Notes = Record<string, unknown> | string | null;
function fixture(
  base: Notes = clauses,
  project: Notes = null,
  submission = "L’offerta completa deve essere presentata entro il 1 febbraio 2030.",
) {
  const ctx = {
    target: { kind: "lot", publicationId: "toy-base", lotId: "toy-lot" },
    dependency: { publicationId: "toy-base" },
    projectBarrier: { reason: "not_reviewed" },
    targetContent: {
      identity: { detailUrl: "https://example.invalid/toy-base" },
      selectedLot: {
        path: "/lots/3",
        record: {
          id: "toy-lot",
          lotNumber: 4,
          orderAddressDescription: { it: "Nei locali dell’offerente" },
          orderDescription: { it: "Toy seminar facilities in Ticino" },
        },
      },
      projectSections: {
        base: { participantLotsLimitationNote: structuredClone(base) },
        dates: { offerDeadline: "2030-02-01T23:59:00+01:00" },
        "project-info": {
          participantLotsLimitationNote: structuredClone(project),
          offerSpecificNote: { it: submission },
        },
      },
    },
  } as unknown as LotSourceContext;
  const req = native.buildOperationalEvidenceRequest(ctx),
    p = createFieldBoundProtocol(native, req),
    id = (path: string) => {
      const proof = p.catalog.find((p) => p.path === path);
      if (!proof) throw Error("Absent invented field");
      return proof.fieldId;
    };
  const raw = {
    binding: p.binding,
    country: null,
    countryEvidence: [] as string[],
    canton: null,
    cantonEvidence: [] as string[],
    city: null,
    cityEvidence: [] as string[],
    deadline: {
      value: "2030-02-01T23:59:00+01:00",
      appliesToTarget: true,
      dateFieldId: id("/dates/offerDeadline"),
      submissionFieldIds: [id("/project-info/offerSpecificNote/it")],
      lotApplicabilityFieldIds: [] as string[],
      otherEvidenceFieldIds: [] as string[],
    },
    rationale: "Invented base-scope fixture; no provider",
    issues: [],
  };
  const cite = (container: "base" | "project-info") => {
    raw.deadline.lotApplicabilityFieldIds = Object.keys(clauses)
      .filter((k) => k !== "en")
      .map((lang) => id(`/${container}/participantLotsLimitationNote/${lang}`));
    return raw;
  };
  return { ctx, req, p, id, raw, cite };
}
describe("Original base and project-info applicability paths, invented sources only", () => {
  it("accepts exact own base proofs without remapping path, scope or quote", () => {
    const f = fixture(),
      answer = f.p.decodeReading(f.cite("base"));
    expect(
      answer.deadlineEvidence.filter((p) => p.path.startsWith("/base/")),
    ).toEqual(
      Object.entries(clauses)
        .filter(([, v]) => v !== null)
        .map(([language, quote]) => ({
          scope: "project_context",
          path: `/base/participantLotsLimitationNote/${language}`,
          quote,
        })),
    );
  });
  it("preserves supported project-info-only proofs", () => {
    const f = fixture(null, clauses);
    expect(f.p.decodeReading(f.cite("project-info")).deadline).toBe(
      "2030-02-01T23:59:00+01:00",
    );
  });
  it("equal dual containers allow exact base evidence without precedence", () => {
    const f = fixture(clauses, clauses);
    expect(f.p.decodeReading(f.cite("base")).deadlineEvidence[2].path).toBe(
      "/base/participantLotsLimitationNote/de",
    );
  });
  it("equal dual containers allow exact project-info evidence", () => {
    const f = fixture(clauses, clauses);
    expect(
      f.p.decodeReading(f.cite("project-info")).deadlineEvidence[2].path,
    ).toBe("/project-info/participantLotsLimitationNote/de");
  });
  it("project-info restriction vetoes base evidence even when not selected", () => {
    const f = fixture(clauses, {
      ...clauses,
      it: "Solo il lotto 1 è ammesso.",
    });
    expect(() => f.p.decodeReading(f.cite("base"))).toThrow(
      "explicit lot applicability scope",
    );
  });
  it("base restriction vetoes project-info evidence even when not selected", () => {
    const f = fixture({ ...clauses, de: "Nur Los 1." }, clauses);
    expect(() => f.p.decodeReading(f.cite("project-info"))).toThrow(
      "explicit lot applicability scope",
    );
  });
  it("conflict cannot be bypassed with explicit all-lots submission fallback", () => {
    const f = fixture(
      { ...clauses, it: "Solo il lotto 1 è ammesso." },
      clauses,
      "L’offerta completa per tutti i lotti deve essere presentata entro il 1 febbraio 2030.",
    );
    f.raw.deadline.lotApplicabilityFieldIds = f.raw.deadline.submissionFieldIds;
    expect(() => f.p.decodeReading(f.raw)).toThrow(
      "explicit lot applicability scope",
    );
  });
  it("unsupported language is unresolved even if selected other language is valid", () => {
    const f = fixture({ ...clauses, rm: "Unknown limitation." });
    expect(() => f.p.decodeReading(f.cite("base"))).toThrow(
      "explicit lot applicability scope",
    );
  });
  it("extra material condition remains unresolved", () => {
    const f = fixture({
      ...clauses,
      it: clauses.it + " Solo imprese invitate.",
    });
    expect(() => f.p.decodeReading(f.cite("base"))).toThrow(
      "explicit lot applicability scope",
    );
  });
  it("wrong container shape cannot be overridden by the supported other container", () => {
    const f = fixture("Only selected lots.", clauses);
    expect(() => f.p.decodeReading(f.cite("project-info"))).toThrow(
      "explicit lot applicability scope",
    );
  });
  it("absence of own applicability citation rejects despite supported source text", () => {
    const f = fixture();
    expect(() => f.p.decodeReading(f.raw)).toThrow(
      "explicit submission and lot-applicability",
    );
  });
  it("wrong path for full quote remains native rejection, also for null facts", () => {
    const f = fixture(),
      answer = f.p.decodeReading(f.cite("base"));
    answer.cityEvidence = [
      {
        scope: "selected_lot",
        path: "/lots/3/orderAddressDescription/it",
        quote: "Toy seminar facilities in Ticino",
      },
    ];
    expect(() => native.operationalReviewRequest(f.req, answer)).toThrow(
      "quote not exact original field",
    );
  });
  it("unknown reference rejects; number of lot supplies no fallback", () => {
    const f = fixture();
    f.raw.deadline.lotApplicabilityFieldIds = ["f99999"];
    expect(() => f.p.decodeReading(f.raw)).toThrow(
      "reference reading schema invalid",
    );
  });
  it("own ref for address retains its own original string rather than nearby description", () => {
    const f = fixture();
    f.raw.cityEvidence = [f.id("/lots/3/orderAddressDescription/it")];
    const a = f.p.decodeReading(f.cite("base"));
    expect(a.cityEvidence[0].quote).toBe("Nei locali dell’offerente");
    expect(a.city).toBeNull();
  });
  it("base proof is preserved through independent review, record and reader", () => {
    const f = fixture(),
      raw = f.cite("base"),
      a = f.p.decodeReading(raw),
      review = {
        binding: f.p.binding,
        checks: Object.fromEntries(
          ["country", "canton", "city", "deadline"].map((k) => [
            k,
            {
              verdict: k === "deadline" ? "supported" : "not_verifiable",
              evidence:
                k === "deadline"
                  ? [
                      raw.deadline.dateFieldId,
                      ...raw.deadline.submissionFieldIds,
                      ...raw.deadline.lotApplicabilityFieldIds,
                    ]
                  : [],
              rationale: "Invented independent review",
            },
          ]),
        ),
        issues: [],
      };
    const record = f.p.record(raw, review, {
      id: "toy",
      at: "2030-01-01T12:00:00Z",
      model: "invented",
    });
    expect(record.answer).toEqual(a);
    expect(native.readOperationalEvidence([record], f.ctx)).toEqual(record);
  });
  it("different review proof cannot replace own base evidence with duplicate project-info text", () => {
    const f = fixture(clauses, clauses),
      raw = f.cite("base"),
      review = {
        binding: f.p.binding,
        checks: Object.fromEntries(
          ["country", "canton", "city", "deadline"].map((k) => [
            k,
            {
              verdict: k === "deadline" ? "supported" : "not_verifiable",
              evidence:
                k === "deadline"
                  ? [
                      raw.deadline.dateFieldId,
                      ...raw.deadline.submissionFieldIds,
                      f.id("/project-info/participantLotsLimitationNote/it"),
                    ]
                  : [],
              rationale: "Invented invalid review",
            },
          ]),
        ),
        issues: [],
      };
    expect(() =>
      f.p.record(raw, review, {
        id: "toy",
        at: "2030-01-01T12:00:00Z",
        model: "invented",
      }),
    ).toThrow("verify each own proof");
  });
});
