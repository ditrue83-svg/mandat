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
type Draft = {
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
  draft: Draft;
}) {
  const proof = coverageProofSchema.parse(input.proof);
  if (
    JSON.stringify(proof.map((row) => row.sourceRef).sort()) !==
    JSON.stringify([...input.ownedSourceRefs].sort())
  )
    throw new Error("Coverage proof requires every owned source exactly once");
  const candidates = new Map<string, { text: string; refs: readonly string[] }>(
    [
      [
        "/summary",
        { text: input.draft.summary, refs: input.draft.summarySourceRefs },
      ],
      ...input.draft.components.flatMap(
        (
          item,
          index,
        ): [string, { text: string; refs: readonly string[] }][] => [
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
      ...input.draft.details.map(
        (item, index): [string, { text: string; refs: readonly string[] }] => [
          `/details/${index}/explanation`,
          { text: item.explanation, refs: item.sourceRefs },
        ],
      ),
    ],
  );
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
