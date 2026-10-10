import { readFileSync } from "node:fs";
import { test, expect } from "vitest";
import {
  captureLotSourceSnapshot,
  resolveLotSourceContext,
} from "../src/lib/lot-source-context";
import {
  buildOperationalEvidenceRequest,
  buildOperationalReadingTask,
  buildOperationalReviewTask,
  decodeOperationalTaskPrompt,
  recordOperationalEvidence,
} from "../src/lib/lot-operational-evidence";
import { openaiResponseBody } from "../src/lib/openai-responses";
const cases = JSON.parse(
  readFileSync(
    new URL("./fixtures/operational-inventory34.json", import.meta.url),
    "utf8",
  ),
);
for (const item of cases)
  test(`Lossless inventory34 reading and review within original wire cap: ${item.case.id}`, () => {
    const src = item.source,
      publication = { summary: null, requirements: [], ...src.publication };
    const snapshot = captureLotSourceSnapshot({
      publicationId: publication.id,
      observationId: src.observationId,
      sourceScopeReview: publication.sourceScopeReview ?? null,
      acquisition: { state: "accepted", archive: src.archive },
    });
    const request = buildOperationalEvidenceRequest(
        resolveLotSourceContext(snapshot, item.case.target, []),
      ),
      task = buildOperationalReadingTask(request),
      decoded = decodeOperationalTaskPrompt(task.prompt);
    expect(decoded.source).toEqual(request.data);
    for (const proof of decoded.originalProofCatalog) {
      const root =
          proof.scope === "selected_lot"
            ? request.data.selectedLot
            : request.data.projectSections,
        prefix =
          proof.scope === "selected_lot" ? request.data.selectedPath : "";
      const value = proof.path
        .slice(prefix.length + 1)
        .split("/")
        .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"))
        .reduce((v: any, k: string) => v[k], root);
      expect(proof.quote).toBe(value);
    }
    const project = request.data.projectSections as any,
      lot = request.data.selectedLot as any,
      path = request.data.selectedPath,
      proof = (scope: string, path: string, quote: string) => ({
        scope,
        path,
        quote,
      });
    const answer = {
      country: "CH",
      countryEvidence: [
        proof(
          "selected_lot",
          path + "/orderAddress/countryId",
          lot.orderAddress.countryId,
        ),
      ],
      canton: null,
      cantonEvidence: [],
      city: null,
      cityEvidence: [],
      deadline: project.dates.offerDeadline,
      deadlineAppliesToTarget: true,
      deadlineEvidence: [
        proof(
          "project_context",
          "/dates/offerDeadline",
          project.dates.offerDeadline,
        ),
        ...["de", "fr", "it"].flatMap((lang) => [
          proof(
            "project_context",
            "/project-info/offerSpecificNote/" + lang,
            project["project-info"].offerSpecificNote[lang],
          ),
          proof(
            "project_context",
            "/project-info/participantLotsLimitationNote/" + lang,
            project["project-info"].participantLotsLimitationNote[lang],
          ),
        ]),
      ],
      rationale: "Capacity fixture only; not qualification",
      issues: [],
    };
    const review = buildOperationalReviewTask(request, answer),
      decodedReview = decodeOperationalTaskPrompt(review.prompt);
    expect(decodedReview.source).toEqual(request.data);
    expect(decodedReview.reading).toEqual(answer);
    const wireReading = openaiResponseBody(
        "gpt-6-luna",
        task.system,
        task.prompt,
        task.maxTokens,
        task.responseFormat,
        "high",
      ),
      wireReview = openaiResponseBody(
        "gpt-6-luna",
        review.system,
        review.prompt,
        review.maxTokens,
        review.responseFormat,
        "high",
      );
    expect(Buffer.byteLength(JSON.stringify(wireReading))).toBeLessThanOrEqual(
      200000,
    );
    expect(Buffer.byteLength(JSON.stringify(wireReview))).toBeLessThanOrEqual(
      200000,
    );
    const checks = Object.fromEntries(
      ["country", "canton", "city", "deadline"].map((k) => [
        k,
        {
          verdict: (answer as any)[k] === null ? "not_verifiable" : "supported",
          evidence: (answer as any)[k + "Evidence"],
          rationale: "Synthetic capacity fixture",
        },
      ]),
    );
    expect(() =>
      recordOperationalEvidence(answer, { checks, issues: [] }, request, {
        id: "synthetic-capacity",
        at: "2026-10-10T00:00:00Z",
        model: "gpt-6-luna",
      }),
    ).not.toThrow();
    console.info(
      JSON.stringify({
        caseId: item.case.id,
        readingBytes: Buffer.byteLength(JSON.stringify(wireReading)),
        reviewBytes: Buffer.byteLength(JSON.stringify(wireReview)),
        lossless: true,
        caseQualified: false,
      }),
    );
  });

test("The dictionary codec preserves original null/false/empty structure and escaped source keys", () => {
  const item = structuredClone(cases[0]),
    src = item.source;
  const archive = src.archive;
  const snapshot = captureLotSourceSnapshot({
      publicationId: src.publication.id,
      observationId: src.observationId,
      sourceScopeReview: null,
      acquisition: { state: "accepted", archive },
    }),
    request = buildOperationalEvidenceRequest(
      resolveLotSourceContext(snapshot, item.case.target, []),
    );
  expect(
    decodeOperationalTaskPrompt(buildOperationalReadingTask(request).prompt)
      .source,
  ).toEqual(request.data);
});
