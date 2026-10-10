import { z } from "zod";

export const coverageProofSchema = z
  .array(
    z.strictObject({
      sourceRef: z.string().regex(/^[sf]\d+$/),
      disposition: z.enum(["represented", "not_required", "missing"]),
      witnesses: z
        .array(
          z.strictObject({
            draftPath: z
              .string()
              .regex(
                /^\/(?:summary|components\/\d+\/(?:description|meaning\/statement)|details\/\d+\/explanation)$/,
              ),
            quote: z.string().min(1).max(1200),
          }),
        )
        .max(64),
    }),
  )
  .max(1024);

export type CoverageProof = z.infer<typeof coverageProofSchema>;
export type CoverageDraft = {
  summary: string;
  summarySourceRefs: readonly string[];
  components: readonly {
    description: string;
    meaning: { statement: string };
    sourceRefs: readonly string[];
  }[];
  details: readonly {
    explanation: string;
    sourceRefs: readonly string[];
    lf?: boolean;
  }[];
};

// Proof of presence is separate from the reviewer's semantic judgment. A
// pointer to a source date cannot certify that the date occurs in the draft.
export function validateCoverageProof(input: {
  proof: CoverageProof;
  ownedSourceRefs: readonly string[];
  requiredSourceRefs?: readonly string[];
  kind: "scope_coverage" | "contract_clause_coverage";
  verdict: "supported" | "contradicted" | "not_verifiable";
  draft: CoverageDraft;
  titleContextRefs?: Record<string, string[]>;
  requiredWitnessPaths?: Record<string, string[]>;
}) {
  const proof = coverageProofSchema.parse(input.proof);
  if (
    JSON.stringify(proof.map((row) => row.sourceRef).sort()) !==
    JSON.stringify([...input.ownedSourceRefs].sort())
  )
    throw new Error("Coverage proof requires every owned source exactly once");
  const candidates = coverageDraftFields(input.draft);
  for (const row of proof) {
    if (
      input.verdict === "supported" &&
      input.requiredWitnessPaths?.[row.sourceRef]?.some(
        (path) => !row.witnesses.some((w) => w.draftPath === path),
      )
    )
      throw new Error(
        "Complete literal coverage requires every original fragment witness",
      );
    if (row.disposition === "represented") {
      if (!row.witnesses.length)
        throw new Error("Represented fact requires a draft witness");
      for (const witness of row.witnesses) {
        const own = candidates.get(witness.draftPath);
        if (
          !witness.quote.trim() ||
          !own?.text.includes(witness.quote) ||
          !(
            own.refs.includes(row.sourceRef) ||
            (input.kind === "scope_coverage" &&
              own.refs.some((ref) =>
                input.titleContextRefs?.[row.sourceRef]?.includes(ref),
              ))
          ) ||
          (input.kind === "contract_clause_coverage" &&
            !witness.draftPath.startsWith("/details/"))
        )
          throw new Error(
            "Coverage witness must quote its own cited draft field",
          );
      }
    } else {
      if (row.witnesses.length)
        throw new Error("Absent fact cannot claim a draft witness");
      if (
        row.disposition === "not_required" &&
        (input.kind === "contract_clause_coverage" ||
          input.requiredSourceRefs?.includes(row.sourceRef))
      )
        throw new Error("A mandatory clause cannot be classified as optional");
      if (row.disposition === "missing" && input.verdict === "supported")
        throw new Error(
          "Missing material fact cannot receive supported coverage",
        );
    }
  }
  return proof;
}

function coverageDraftFields(draft: CoverageDraft) {
  return new Map<string, { text: string; refs: readonly string[] }>([
    ["/summary", { text: draft.summary, refs: draft.summarySourceRefs }],
    ...draft.components.flatMap(
      (item, index): [string, { text: string; refs: readonly string[] }][] => [
        [
          `/components/${index}/description`,
          { text: item.description, refs: item.sourceRefs },
        ],
        [
          `/components/${index}/meaning/statement`,
          { text: item.meaning.statement, refs: item.sourceRefs },
        ],
      ],
    ),
    ...draft.details.map(
      (item, index): [string, { text: string; refs: readonly string[] }] => [
        `/details/${index}/explanation`,
        { text: item.explanation, refs: item.sourceRefs },
      ],
    ),
  ]);
}

export type CoverageBinding = {
  claimId: string;
  kind: "scope_coverage" | "contract_clause_coverage";
  sourceRefs: string[];
  requiredSourceRefs?: string[];
  witnessesBySource: Record<string, { draftPath: string; quote: string }[]>;
  titleContextRefs?: Record<string, string[]>;
  requiredWitnessPaths?: Record<string, string[]>;
};

// Titles in the two original title sections are lookup context only.
// Different languages may disagree: candidate presence never approves meaning.
export function titleContextReferences(
  passages: readonly {
    id: string;
    scope: string;
    rawPath: string;
  }[],
): Record<string, string[]> {
  const titles = passages.filter((p) =>
    /^\/(?:base|project-info)\/title\/(?:de|en|fr|it)$/.test(p.rawPath),
  );
  return Object.fromEntries(
    titles.map((p) => [
      p.id,
      titles
        .filter((other) => other.scope === p.scope)
        .map((other) => other.id),
    ]),
  );
}

// A candidate proves that a cited field exists, never that its meaning covers
// the fact. The reviewer must select it and judge every proposition separately.
export function bindCoverageWitnesses(
  claim: Pick<
    CoverageBinding,
    "claimId" | "kind" | "sourceRefs" | "requiredSourceRefs"
  >,
  draft: CoverageDraft,
  titleContextRefs?: Record<string, string[]>,
): CoverageBinding {
  const fields = coverageDraftFields(draft);
  return {
    ...claim,
    requiredWitnessPaths: Object.fromEntries(
      claim.sourceRefs.flatMap((sourceRef) => {
        const pieces = draft.details.flatMap((d, i) =>
          d.lf && d.sourceRefs.includes(sourceRef)
            ? [`/details/${i}/explanation`]
            : [],
        );
        return pieces.length ? [[sourceRef, pieces]] : [];
      }),
    ),
    ...(titleContextRefs ? { titleContextRefs } : {}),
    witnessesBySource: Object.fromEntries(
      claim.sourceRefs.map((sourceRef) => [
        sourceRef,
        [...fields].flatMap(([draftPath, field]) =>
          (field.refs.includes(sourceRef) ||
            (claim.kind === "scope_coverage" &&
              field.refs.some((ref) =>
                titleContextRefs?.[sourceRef]?.includes(ref),
              ))) &&
          field.text.trim() &&
          (claim.kind !== "contract_clause_coverage" ||
            draftPath.startsWith("/details/"))
            ? [{ draftPath, quote: field.text }]
            : [],
        ),
      ]),
    ),
  };
}

export function coverageHasWitnesses(binding?: CoverageBinding) {
  return (
    !binding ||
    binding.sourceRefs.every(
      (ref) =>
        (binding.kind !== "contract_clause_coverage" &&
          !binding.requiredSourceRefs?.includes(ref)) ||
        binding.witnessesBySource[ref].length > 0,
    )
  );
}

type CoverageSelectionRow = {
  disposition: "represented" | "not_required" | "missing";
  draftPaths: string[];
};

// Reuse identical schemas for absent facts. Large source groups contain many
// optional administrative fields; repeating the same row schema for each ID
// needlessly exhausts the request allowance without adding any evidence.
const emptyDraftPaths = z.array(z.string()).max(0);
const missingSelection = z.strictObject({
  disposition: z.literal("missing"),
  draftPaths: emptyDraftPaths,
});
const optionalSelection = z.strictObject({
  disposition: z.literal("not_required"),
  draftPaths: emptyDraftPaths,
});
const absentSelection = z.strictObject({
  disposition: z.enum(["missing", "not_required"]),
  draftPaths: emptyDraftPaths,
});

export function coverageSelectionSchema(
  binding?: CoverageBinding,
  supported = false,
) {
  return z.strictObject(
    Object.fromEntries(
      (binding?.sourceRefs ?? []).map(
        (sourceRef): [string, z.ZodType<CoverageSelectionRow>] => {
          const paths = binding!.witnessesBySource[sourceRef].map(
            (w) => w.draftPath,
          );
          const required =
            binding!.kind === "contract_clause_coverage" ||
            binding!.requiredSourceRefs?.includes(sourceRef);
          const absent = required
            ? missingSelection
            : supported
              ? optionalSelection
              : absentSelection;
          if (!paths.length) {
            if (supported && required)
              throw new Error(
                "Supported mandatory coverage requires a draft candidate",
              );
            return [sourceRef, absent] as const;
          }
          const complete = supported
            ? binding!.requiredWitnessPaths?.[sourceRef]
            : undefined;
          const selectedPaths = complete?.length ? complete : paths;
          const represented = z.strictObject({
            disposition: z.literal("represented"),
            draftPaths: z
              .array(z.enum(selectedPaths))
              .min(complete?.length || 1)
              .max(selectedPaths.length),
          });
          return [
            sourceRef,
            supported && required
              ? represented
              : z.union([represented, absent]),
          ] as const;
        },
      ),
    ),
  );
}

export function projectCoverageSelection(
  selection: unknown,
  binding?: CoverageBinding,
): CoverageProof {
  const parsed = coverageSelectionSchema(binding).parse(selection);
  return (binding?.sourceRefs ?? []).map((sourceRef) => {
    const row = parsed[sourceRef];
    if (
      row.disposition === "represented" &&
      binding!.requiredWitnessPaths?.[sourceRef]?.some(
        (path) => !row.draftPaths.includes(path),
      )
    )
      throw new Error(
        "Literal clause coverage requires every intersecting draft fragment",
      );
    if (new Set(row.draftPaths).size !== row.draftPaths.length)
      throw new Error("Coverage selection repeats a draft witness");
    return {
      sourceRef,
      disposition: row.disposition,
      witnesses: row.draftPaths.map((draftPath) => ({
        ...binding!.witnessesBySource[sourceRef].find(
          (w) => w.draftPath === draftPath,
        )!,
      })),
    };
  });
}
