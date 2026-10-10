import assert from "node:assert/strict";
import { test } from "vitest";
import { originalClauseTextParts } from "../src/lib/source-clause-literals";

const passage = (text: string, language = "it", start = 0) => ({
  text,
  rawPath: `/terms/otherRequirements/${language}`,
  scope: "project_context",
  startUtf16: start,
  endUtf16: start + text.length,
});

test("A short single-language condition retains the exact date and every instruction", () => {
  const text =
    "Documenti dal 3 marzo 2031. Scaricare, compilare tutte le parti e consegnare tutte le pagine.";
  assert.deepEqual(originalClauseTextParts([passage(text)]), [text]);
});

test("Long parallel conditions preserve all wording, markup, accents and supplementary characters", () => {
  const de =
    "<p>PDF im ZIP vor Fristende einreichen; Hochladen genügt nicht. Keine Bestätigung. Ä 📄</p> ".repeat(
      10,
    );
  const it =
    "<p>Inviare un ZIP prima del termine, non basta caricarlo. Nessuna conferma. È 📄</p> ".repeat(
      10,
    );
  const originals = [passage(de, "de"), passage(it)];
  const before = JSON.stringify(originals);
  const parts = originalClauseTextParts(originals)!;
  assert(parts.length > 2);
  assert(parts.every((p) => p.length <= 600 && p.isWellFormed() && p.trim()));
  assert.equal(parts.join(""), `DE: ${de}\nIT: ${it}`);
  assert.equal(JSON.stringify(originals), before);
});

test("Contiguous fragments join in original position without trimming or invented spaces", () => {
  assert.deepEqual(
    originalClauseTextParts([
      passage("condizione.", "it", 5),
      passage("Una \n"),
    ]),
    ["Una \ncondizione."],
  );
  for (const fragments of [
    [passage("Primo "), passage("ultimo", "it", 10)],
    [passage("Primo "), passage("altro", "it", 4)],
    [passage("parte", "it", 1)],
    [{ ...passage("testo"), endUtf16: 3 }],
  ])
    assert.throws(
      () => originalClauseTextParts(fragments),
      /complete contiguous/,
    );
});

test("Different scopes, empty content and oversized tokens fail without truncation", () => {
  assert.throws(
    () =>
      originalClauseTextParts([
        passage("A", "de"),
        { ...passage("B"), scope: "selected_lot" },
      ]),
    /one scope/,
  );
  for (const text of [" ", "\u0000", "\ud800", "x".repeat(601)])
    assert.throws(() => originalClauseTextParts([passage(text)]));
  assert.deepEqual(originalClauseTextParts([passage("x".repeat(600))]), [
    "x".repeat(600),
  ]);
});

test("Null stays absent and scalar keeps its original path and value", () => {
  assert.equal(originalClauseTextParts([]), undefined);
  assert.equal(
    originalClauseTextParts([
      { rawPath: "/terms/otherRequirements/it", scope: "project_context" },
    ]),
    undefined,
  );
  assert.deepEqual(
    originalClauseTextParts([
      { ...passage("no"), rawPath: "/terms/subContractorAllowed" },
    ]),
    ["/terms/subContractorAllowed: no"],
  );
});
