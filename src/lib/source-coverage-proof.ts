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
  details: readonly { explanation: string; sourceRefs: readonly string[] }[];
};

// Proof of presence is separate from the reviewer's semantic judgment. A
// pointer to a source date cannot certify that the date occurs in the draft.
export function validateCoverageProof(input: {
  proof: CoverageProof;
  ownedSourceRefs: readonly string[];
  kind: "scope_coverage" | "contract_clause_coverage";
  verdict: "supported" | "contradicted" | "not_verifiable";
  draft: CoverageDraft;
}) {
  const proof = coverageProofSchema.parse(input.proof);
  if (
    JSON.stringify(proof.map((row) => row.sourceRef).sort()) !==
    JSON.stringify([...input.ownedSourceRefs].sort())
  )
    throw new Error("Coverage proof requires every owned source exactly once");
  const candidates = coverageDraftFields(input.draft);
  for (const row of proof) {
    if (row.disposition === "represented") {
      if (!row.witnesses.length)
        throw new Error("Represented fact requires a draft witness");
      for (const witness of row.witnesses) {
        const own = candidates.get(witness.draftPath);
        if (
          !witness.quote.trim() ||
          !own?.text.includes(witness.quote) ||
          !own.refs.includes(row.sourceRef) ||
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
        input.kind === "contract_clause_coverage"
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
  witnessesBySource: Record<string, { draftPath: string; quote: string }[]>;
};

// A candidate proves that a cited field exists, never that its meaning covers
// the fact. The reviewer must select it and judge every proposition separately.
export function bindCoverageWitnesses(
  claim: Pick<CoverageBinding, "claimId" | "kind" | "sourceRefs">,
  draft: CoverageDraft,
): CoverageBinding {
  const fields = coverageDraftFields(draft);
  return {
    ...claim,
    witnessesBySource: Object.fromEntries(
      claim.sourceRefs.map((sourceRef) => [
        sourceRef,
        [...fields].flatMap(([draftPath, field]) =>
          field.refs.includes(sourceRef) &&
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
    binding?.kind !== "contract_clause_coverage" ||
    binding.sourceRefs.every((ref) => binding.witnessesBySource[ref].length > 0)
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
          const absent =
            binding!.kind === "contract_clause_coverage"
              ? missingSelection
              : supported
                ? optionalSelection
                : absentSelection;
          if (!paths.length) {
            if (supported && binding!.kind === "contract_clause_coverage")
              throw new Error(
                "Supported mandatory coverage requires a draft candidate",
              );
            return [sourceRef, absent] as const;
          }
          const represented = z.strictObject({
            disposition: z.literal("represented"),
            draftPaths: z.array(z.enum(paths)).min(1).max(paths.length),
          });
          return [
            sourceRef,
            supported && binding!.kind === "contract_clause_coverage"
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
