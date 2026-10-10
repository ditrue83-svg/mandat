import assert from "node:assert/strict";
import { test } from "vitest";
import { buildSourceLiteralCatalogue } from "../src/lib/source-literal-catalogue";
import { resolveSourceSelection } from "../src/lib/source-selection";
const p = (id: string, text: string, start = 0) => ({
  id,
  text,
  startUtf16: start,
  endUtf16: start + text.length,
  rawPath: "/procurement/orderDescription/it",
  scope: "project_context" as const,
  role: "service" as const,
  url: "https://example.invalid",
});
test("Catalogue copies every original character and parentheses across contiguous source fragments", () => {
  const text =
    "<p>Ufficio Nord (Göschenen), opzione; manutenzione ordinaria e straordinaria. È 📄</p> ".repeat(
      20,
    );
  const original = [
    p("s1", text.slice(0, 1200)),
    p("s2", text.slice(1200), 1200),
  ];
  const groups = [{ id: "g1", sourceRefs: ["s1", "s2"] }];
  const c = buildSourceLiteralCatalogue(original, groups);
  assert.equal(c.literals[0].parts.map((p) => p[1]).join(""), text);
  assert(c.selections.every((s) => s.endUtf16 - s.startUtf16 <= 600));
  for (const s of c.selections) {
    const { id, ...span } = s;
    const copied = resolveSourceSelection(span, original, groups);
    assert.equal(copied.text, c.literals[0].parts.find((p) => p[0] === id)![1]);
  }
});
test("Catalogue cannot make an original field gap or cross a scope valid", () => {
  const a = p("s1", "Fornitura originale. ");
  const b = p("s2", "Manutenzione originale. ", a.endUtf16 + 1);
  assert.throws(
    () =>
      buildSourceLiteralCatalogue(
        [a, b],
        [{ id: "g1", sourceRefs: ["s1", "s2"] }],
      ),
    /gaps/,
  );
  assert.throws(
    () =>
      buildSourceLiteralCatalogue(
        [
          a,
          {
            ...b,
            startUtf16: a.endUtf16,
            endUtf16: a.endUtf16 + b.text.length,
            scope: "selected_lot" as any,
          },
        ],
        [{ id: "g1", sourceRefs: ["s1", "s2"] }],
      ),
    /scopes/,
  );
});

test("HTML paragraphs without intervening whitespace keep available complete final removal and restoration sentences together", () => {
  const lead = "<p>Opere di costruzione necessarie. </p>".repeat(25);
  const end =
    "<p>Al termine, moduli e opere civili sono rimossi.</p><p>Le superfici sono ripristinate.</p>";
  const text = lead + end;
  const c = buildSourceLiteralCatalogue([p("s1", text)], []);
  assert.equal(c.literals[0].parts.map((p) => p[1]).join(""), text);
  assert(c.literals[0].parts.some((p) => p[1].includes(end)));
});

test("Whitespace-only original fields and trailing pieces remain byte-exact storage, never empty citations", () => {
  const originals = [
    p("s1", "\n"),
    p("s2", "A".repeat(599) + " " + "\n".repeat(10)),
    p("s3", "Altro testo."),
  ];
  const before = JSON.stringify(originals),
    c = buildSourceLiteralCatalogue(originals, []);
  for (const original of originals)
    assert.equal(
      c.literals
        .find((f) => f.sourceRef === original.id)!
        .parts.map((part) => part[1])
        .join(""),
      original.text,
    );
  assert(!c.selections.some((s) => s.sourceRef === "s1"));
  assert.equal(
    new Set(c.literals.flatMap((f) => f.parts.map((p) => p[0]))).size,
    c.literals.flatMap((f) => f.parts).length,
  );
  for (const selected of c.selections) {
    const { id: _id, ...span } = selected;
    assert(resolveSourceSelection(span, originals).text.trim());
  }
  assert.equal(JSON.stringify(originals), before);
});
test("Unicode beside the600-boundary keeps every code point and original whitespace", () => {
  const text = "a ".repeat(299) + "b😀 parola finale. ";
  const originals = [p("s1", text)];
  const c = buildSourceLiteralCatalogue(originals, []);
  assert.equal(c.literals[0].parts.map((part) => part[1]).join(""), text);
  assert(c.literals[0].parts.every((part) => part[1].isWellFormed()));
});
