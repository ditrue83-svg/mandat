import { describe, it, expect } from "vitest";
import * as native from "../src/lib/lot-operational-evidence";
import { createFieldBoundProtocol } from "../src/lib/field-bound-protocol.mjs";
import type { LotSourceContext } from "../src/lib/lot-source-context";
const first = "2030-02-01T23:59:00+01:00",
  other = "2030-03-01T23:59:00+01:00",
  equivalent = "2030-02-01T22:59:00Z";
function fixture(
  flat: unknown = first,
  nested: unknown = undefined,
  shared: unknown = first,
) {
  const ctx = {
    target: { kind: "lot", publicationId: "toy-direct-date", lotId: "toy-lot" },
    dependency: { publicationId: "toy-direct-date" },
    projectBarrier: { reason: "not_reviewed" },
    targetContent: {
      identity: { detailUrl: "https://example.invalid/direct-date" },
      selectedLot: {
        path: "/lots/2",
        record: {
          id: "toy-lot",
          offerDeadline: flat,
          dates: { offerDeadline: nested },
        },
      },
      projectSections: {
        dates: { offerDeadline: shared },
        base: {
          participantLotsLimitationNote: {
            it: "Gli offerenti possono candidarsi per un solo lotto o per più lotti. La valutazione avviene separatamente per ogni lotto.",
          },
        },
        "project-info": {
          offerSpecificNote: {
            it: "L’offerta completa deve essere presentata entro il 1 febbraio 2030.",
          },
        },
      },
    },
  } as unknown as LotSourceContext;
  const req = native.buildOperationalEvidenceRequest(ctx),
    p = createFieldBoundProtocol(native, req),
    id = (path: string) => {
      const ref = p.catalog.find((p) => p.path === path);
      if (!ref) throw Error("Absent toy ref");
      return ref.fieldId;
    };
  function raw(path = "/lots/2/offerDeadline") {
    const ref = p.catalog.find((p) => p.path === path)!;
    return {
      binding: p.binding,
      country: null,
      countryEvidence: [],
      canton: null,
      cantonEvidence: [],
      city: null,
      cityEvidence: [],
      deadline: {
        value: ref.quote,
        appliesToTarget: true,
        dateFieldId: ref.fieldId,
        submissionFieldIds:
          path === "/dates/offerDeadline"
            ? [id("/project-info/offerSpecificNote/it")]
            : ([] as string[]),
        lotApplicabilityFieldIds:
          path === "/dates/offerDeadline"
            ? [id("/base/participantLotsLimitationNote/it")]
            : ([] as string[]),
        otherEvidenceFieldIds: [] as string[],
      },
      rationale: "Invented direct-date conflict fixture",
      issues: [],
    };
  }
  const review = (reading: ReturnType<typeof raw>) => ({
    binding: p.binding,
    checks: Object.fromEntries(
      ["country", "canton", "city", "deadline"].map((k) => [
        k,
        {
          verdict: k === "deadline" ? "supported" : "not_verifiable",
          evidence:
            k === "deadline"
              ? [
                  reading.deadline.dateFieldId,
                  ...reading.deadline.submissionFieldIds,
                  ...reading.deadline.lotApplicabilityFieldIds,
                  ...reading.deadline.otherEvidenceFieldIds,
                ]
              : [],
          rationale: "Invented independent review",
        },
      ]),
    ),
    issues: [],
  });
  return { ctx, req, p, id, raw, review };
}
const metadata = {
  id: "toy-direct-date-record",
  at: "2030-01-01T12:00:00Z",
  model: "invented-no-provider",
};
describe("No precedence among original selected-lot offer deadlines", () => {
  it("single flat original instant remains supported", () => {
    const f = fixture(),
      a = f.raw();
    expect(f.p.decodeReading(a).deadline).toBe(first);
    expect(
      native.readOperationalEvidence(
        [f.p.record(a, f.review(a), metadata)],
        f.ctx,
      ),
    ).not.toBeNull();
  });
  it("single nested original instant remains supported", () => {
    const f = fixture(null, first),
      a = f.raw("/lots/2/dates/offerDeadline");
    expect(f.p.decodeReading(a).deadline).toBe(first);
  });
  it("two equivalent instants accept flat citation preserving its original spelling", () => {
    const f = fixture(first, equivalent);
    expect(f.p.decodeReading(f.raw()).deadline).toBe(first);
  });
  it("two equivalent instants accept nested citation preserving its original spelling", () => {
    const f = fixture(first, equivalent);
    expect(
      f.p.decodeReading(f.raw("/lots/2/dates/offerDeadline")).deadline,
    ).toBe(equivalent);
  });
  it("flat citation cannot conceal conflicting nested original", () => {
    const f = fixture(first, other);
    expect(() => f.p.decodeReading(f.raw())).toThrow(
      native.OperationalDeadlineConflict,
    );
  });
  it("nested citation cannot conceal conflicting flat original", () => {
    const f = fixture(first, other);
    expect(() =>
      f.p.decodeReading(f.raw("/lots/2/dates/offerDeadline")),
    ).toThrow(native.OperationalDeadlineConflict);
  });
  it("shared citation cannot override conflicting flat original", () => {
    const f = fixture(other, undefined, first);
    expect(() => f.p.decodeReading(f.raw("/dates/offerDeadline"))).toThrow(
      native.OperationalDeadlineConflict,
    );
  });
  it("shared citation cannot override conflicting nested original", () => {
    const f = fixture(first, other, first);
    expect(() => f.p.decodeReading(f.raw("/dates/offerDeadline"))).toThrow(
      native.OperationalDeadlineConflict,
    );
  });
  it("opposite shared/local conflict rejects without choosing earlier or later date", () => {
    const f = fixture(first, undefined, other);
    expect(() => f.p.decodeReading(f.raw("/dates/offerDeadline"))).toThrow(
      native.OperationalDeadlineConflict,
    );
  });
  it("selected citation plus contradictory own shared date proof rejects", () => {
    const f = fixture(first, undefined, other),
      a = f.raw();
    a.deadline.otherEvidenceFieldIds = [f.id("/dates/offerDeadline")];
    a.deadline.submissionFieldIds = [
      f.id("/project-info/offerSpecificNote/it"),
    ];
    a.deadline.lotApplicabilityFieldIds = [
      f.id("/base/participantLotsLimitationNote/it"),
    ];
    expect(() => f.p.decodeReading(a)).toThrow(
      native.OperationalDeadlineConflict,
    );
  });
  it("equivalent selected and shared cited instants are consistent", () => {
    const f = fixture(first, equivalent, equivalent),
      a = f.raw();
    a.deadline.otherEvidenceFieldIds = [f.id("/dates/offerDeadline")];
    a.deadline.submissionFieldIds = [
      f.id("/project-info/offerSpecificNote/it"),
    ];
    a.deadline.lotApplicabilityFieldIds = [
      f.id("/base/participantLotsLimitationNote/it"),
    ];
    expect(f.p.decodeReading(a).deadline).toBe(first);
  });
  it("invalid populated secondary local date cannot be silently discarded", () => {
    const f = fixture(first, "2030-02-30T23:59:00+01:00");
    expect(() => f.p.decodeReading(f.raw())).toThrow(
      native.OperationalDeadlineConflict,
    );
  });
  it("review cannot add an exact contradictory project deadline as supporting proof", () => {
    const f = fixture(first, undefined, other),
      a = f.raw(),
      r = f.review(a);
    r.checks.deadline.evidence.push(f.id("/dates/offerDeadline"));
    expect(() => f.p.record(a, r, metadata)).toThrow(
      native.OperationalDeadlineConflict,
    );
  });
  it("uncited project date does not automatically acquire applicability to a direct lot date", () => {
    const f = fixture(first, undefined, other);
    expect(f.p.decodeReading(f.raw()).deadline).toBe(first);
  });
  it("null unresolved deadline remains null instead of selecting one conflicting local original", () => {
    const f = fixture(first, other),
      a = {
        ...f.raw(),
        deadline: {
          value: null,
          appliesToTarget: null,
          dateFieldId: null,
          submissionFieldIds: [],
          lotApplicabilityFieldIds: [],
          otherEvidenceFieldIds: [],
        },
      };
    expect(f.p.decodeReading(a).deadline).toBeNull();
  });
  it("non-ISO shared quote cannot support the same parsed instant", () => {
    const f = fixture(first, undefined, "1 Feb 2030 22:59 GMT"), a = f.raw();
    a.deadline.otherEvidenceFieldIds = [f.id("/dates/offerDeadline")];
    a.deadline.submissionFieldIds = [f.id("/project-info/offerSpecificNote/it")];
    a.deadline.lotApplicabilityFieldIds = [f.id("/base/participantLotsLimitationNote/it")];
    expect(() => f.p.decodeReading(a)).toThrow(native.OperationalDeadlineConflict);
  });
  it("review cannot support an invalid original date using permissive Date.parse", () => {
    const f = fixture(first, undefined, "1 Feb 2030 22:59 GMT"), a = f.raw(), r = f.review(a);
    r.checks.deadline.evidence.push(f.id("/dates/offerDeadline"));
    expect(() => f.p.record(a, r, metadata)).toThrow(native.OperationalDeadlineConflict);
  });

});
