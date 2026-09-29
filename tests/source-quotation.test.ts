import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isOriginalPassageQuotation,
  isOriginalSourceQuotation,
  originalQuotationReferences,
} from "../src/lib/source-quotation";

const firstSpan = {
  scope: "project_context",
  rawPath: "/description/it",
  url: "https://example.invalid/source",
  startUtf16: 0,
  endUtf16: "Fornitura di quadri ".length,
  text: "Fornitura di quadri ",
};
const secondSpan = {
  ...firstSpan,
  startUtf16: firstSpan.endUtf16,
  endUtf16: firstSpan.endUtf16 + "elettrici 🌳.".length,
  text: "elettrici 🌳.",
};

test("A quotation can span unordered contiguous references from one original field", () => {
  assert.equal(
    isOriginalPassageQuotation([secondSpan, firstSpan], "quadri elettrici 🌳"),
    true,
  );
  assert.equal(isOriginalPassageQuotation([], "quadri"), false);
  assert.equal(isOriginalPassageQuotation([firstSpan], ""), false);
});

test("Quotation references select only the minimal cited spans containing the exact words", () => {
  const passages = [
    { ...secondSpan, id: "s2" },
    { ...firstSpan, id: "s1" },
  ];
  assert.deepEqual(originalQuotationReferences(passages, "Fornitura"), ["s1"]);
  assert.deepEqual(originalQuotationReferences(passages, "elettrici 🌳"), [
    "s2",
  ]);
  assert.deepEqual(
    originalQuotationReferences(passages, "quadri elettrici 🌳"),
    ["s2", "s1"],
  );
  assert.deepEqual(originalQuotationReferences([passages[0]], "Fornitura"), []);
  assert.deepEqual(
    originalQuotationReferences(passages, "quadri idraulici"),
    [],
  );
  assert.deepEqual(originalQuotationReferences(passages, ""), []);
});

test("Repeated quotations retain all cited origins without adding adjacent unrelated text", () => {
  const passages = [
    { ...firstSpan, id: "s1" },
    { ...secondSpan, id: "s2" },
    { ...firstSpan, id: "s3", rawPath: "/title/it" },
  ];
  const before = JSON.stringify(passages);
  assert.deepEqual(originalQuotationReferences(passages, "Fornitura"), [
    "s1",
    "s3",
  ]);
  assert.equal(JSON.stringify(passages), before);
});

test("Quotation location preserves formatting and cannot bridge hidden content", () => {
  const passage = (text: string) => ({
    ...firstSpan,
    id: "s1",
    text,
    endUtf16: text.length,
  });
  assert.deepEqual(
    originalQuotationReferences(
      [passage("<p>Fornitura di <b>beni</b>.</p>")],
      "Fornitura di beni.",
    ),
    ["s1"],
  );
  assert.deepEqual(
    originalQuotationReferences(
      [passage("prima <!-- nascosto --> seconda")],
      "prima seconda",
    ),
    [],
  );
});

test.each([
  { startUtf16: secondSpan.startUtf16 + 1, endUtf16: secondSpan.endUtf16 + 1 },
  { startUtf16: secondSpan.startUtf16 - 1, endUtf16: secondSpan.endUtf16 - 1 },
  { rawPath: "/other/it" },
  { scope: "selected_lot" },
  { url: "https://example.invalid/other-source" },
])(
  "A quotation cannot bridge missing text or distinct origins: %j",
  (change) => {
    assert.equal(
      isOriginalPassageQuotation(
        [firstSpan, { ...secondSpan, ...change }],
        "quadri elettrici 🌳",
      ),
      false,
    );
    assert.deepEqual(
      originalQuotationReferences(
        [
          { ...firstSpan, id: "s1" },
          { ...secondSpan, ...change, id: "s2" },
        ],
        "quadri elettrici 🌳",
      ),
      [],
    );
  },
);

test.each([
  ["<p>lavaggio </p><p>e stiratura</p>", "lavaggio e stiratura"],
  [
    '<p title="un segno > nel titolo">Fornitura di <strong>beni</strong>.</p>',
    "Fornitura di beni.",
  ],
  ["la<strong>va</strong>ggio", "lavaggio"],
  ["<li>Uno</li><li>Due</li>", "Uno Due"],
  ["L&#8217;oggetto &amp; l&apos;azione", "L’oggetto & l'azione"],
  ["Quantità&nbsp;5 &lt; 10", "Quantità 5 < 10"],
  ["Oggetto &#x1F333;", "Oggetto 🌳"],
  ["Prima\n  seconda\t terza", "Prima seconda terza"],
  ["<p>Testo originale</p>", "<p>Testo originale</p>"],
])("Literal source text survives formatting: %s", (source, quote) => {
  assert.equal(isOriginalSourceQuotation(source, quote), true);
});

test.each([
  ["<p>Lavaggio e stiratura</p>", "Pulizia e stiratura"],
  ["<p>Lavaggio non incluso</p>", "Lavaggio incluso"],
  ["<p>Lavaggio, stiratura e trasporto</p>", "Lavaggio e trasporto"],
  ["<p>Service de lavage</p>", "Servizio di lavaggio"],
  ["<p>Fornitura di beni</p>", "fornitura di beni"],
  ["servizio <script>parole omesse</script>lavaggio", "servizio lavaggio"],
  ["servizio <!-- parole omesse -->lavaggio", "servizio lavaggio"],
  ["<script>la<b>va</b>ggio</script>", "lavaggio"],
  ["<template>la<b>va</b>ggio</template>", "lavaggio"],
  ["<script>la<b>va</b>ggio", "lavaggio"],
  [
    "prima <elemento-sconosciuto>seconda</elemento-sconosciuto>",
    "prima seconda",
  ],
  ["prima <p-custom>seconda</p-custom>", "prima seconda"],
  ["prima <span:custom>seconda</span:custom>", "prima seconda"],
  ["L&APOS;azione", "L'azione"],
  ["Quantità < 5 > 2", "Quantità 2"],
  ["&lt;b&gt;lavaggio&lt;/b&gt;", "<b>lavaggio</b> aggiuntivo"],
  ["&amp;lt;b&amp;gt;lavaggio&amp;lt;/b&amp;gt;", "<b>lavaggio</b>"],
  ["Fonte originale", "  "],
])("Formatting cannot change or manufacture wording: %s", (source, quote) => {
  assert.equal(isOriginalSourceQuotation(source, quote), false);
});

test("Encoded markup stays literal text and invalid character references are not discarded", () => {
  assert(
    isOriginalSourceQuotation("&lt;b&gt;uno&lt;/b&gt; due", "<b>uno</b> due"),
  );
  assert.equal(
    isOriginalSourceQuotation("&lt;b&gt;uno&lt;/b&gt; due", "uno due"),
    false,
  );
  for (const entity of ["&#0;", "&#xD800;", "&#1114112;"]) {
    assert.equal(
      isOriginalSourceQuotation(`prima${entity}seconda`, "primaseconda"),
      false,
    );
  }
});
