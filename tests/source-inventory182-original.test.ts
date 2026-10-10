import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildSourceInterpretationRequest,
  materializeSourceInterpretationPassages,
  materializeSourceInterpretationFields,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import { buildSourceLiteralCatalogue } from "../src/lib/source-literal-catalogue";
import { resolveSourceSelection } from "../src/lib/source-selection";
const rows = JSON.parse(
  fs.readFileSync(
    new URL(
      "./fixtures/source-inventory182-original-contexts.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  caseId: string;
  sourceId: string;
  context: SourceInterpretationContext;
}[];
for (const row of rows)
  test(`Original ${row.caseId} keeps its newline-only field without offering an empty quotation`, () => {
    const before = JSON.stringify(row.context),
      request = buildSourceInterpretationRequest(row.context);
    assert.equal(row.sourceId, "inventory-182");
    const original = row.context.body.passages.find((p) => p.id === "s136")!;
    assert.equal(original.rawPath, "/terms/termsNote/it");
    assert.equal(original.text, "\n");
    assert.deepEqual(
      materializeSourceInterpretationPassages(request.prompt),
      row.context.body.passages.map(({ url: _url, ...p }) => p),
    );
    assert.deepEqual(
      materializeSourceInterpretationFields(request.prompt),
      row.context.body.fields.map((f, i) => ({
        ...f,
        ...(f.value !== null ? { id: `f${i}` } : {}),
      })),
    );
    const catalogue = buildSourceLiteralCatalogue(
      row.context.body.passages,
      [],
    );
    assert.equal(
      catalogue.literals
        .find((f) => f.sourceRef === "s136")!
        .parts.map((p) => p[1])
        .join(""),
      "\n",
    );
    assert(!catalogue.selections.some((s) => s.sourceRef === "s136"));
    assert.throws(
      () =>
        resolveSourceSelection(
          { sourceRef: "s136", startUtf16: 0, endUtf16: 1 },
          row.context.body.passages,
        ),
      /empty/,
    );
    assert.equal(JSON.stringify(row.context), before);
    assert(
      Buffer.byteLength(
        request.system +
          request.prompt +
          JSON.stringify(request.responseFormat),
      ) <= 160000,
    );
  });
