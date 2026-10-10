// Real original case10 bytes are used solely for an offline capacity/integrity
// regression. No AI result is read, adopted, accepted or qualified here.
import { test } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  buildSourceInterpretationRequest,
  materializeSourceInterpretationFields,
  materializeSourceInterpretationPassages,
  sourceClauseLiteralFamilies,
  type SourceInterpretationContext,
} from "../src/lib/source-interpretation";
import { openaiResponseBody } from "../src/lib/openai-responses";
import { buildSourceEvidenceReadingRequest } from "../src/lib/source-evidence-reading";
test("Original integrated-work context retains every byte in the new offline source contract within unchanged caps", () => {
  const sourceContext = JSON.parse(
    fs.readFileSync(
      new URL(
        "./fixtures/source-integrated-original-context.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as SourceInterpretationContext;
  const before = JSON.stringify(sourceContext),
    request = buildSourceInterpretationRequest(sourceContext),
    families = sourceClauseLiteralFamilies(sourceContext);
  assert(
    Buffer.byteLength(
      request.system + request.prompt + JSON.stringify(request.responseFormat),
    ) <= 160000,
  );
  assert.deepEqual(
    materializeSourceInterpretationPassages(request.prompt),
    sourceContext.body.passages.map(({ url: _url, ...p }) => p),
  );
  assert.deepEqual(
    materializeSourceInterpretationFields(request.prompt),
    sourceContext.body.fields.map((f, i) => ({
      ...f,
      ...(f.value !== null ? { id: `f${i}` } : {}),
    })),
  );
  const wire = openaiResponseBody(
    "gpt-6-luna",
    request.system,
    request.prompt,
    request.maxTokens,
    request.responseFormat,
    "medium",
  );
  assert(Buffer.byteLength(JSON.stringify(wire)) <= 200000);
  assert(families.contractDetailFamilies.length <= 32);
  assert(families.requiredContractClauses.length > 80);
  const reader = buildSourceEvidenceReadingRequest(sourceContext, {
    model: "invented-offline",
  });
  assert(reader.requests.length <= 32);
  for (const r of reader.requests)
    assert(
      Buffer.byteLength(
        r.system + r.prompt + JSON.stringify(r.responseFormat),
      ) <= 160000,
    );
  assert.equal(JSON.stringify(sourceContext), before);
});
