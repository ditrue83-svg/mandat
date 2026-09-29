import assert from "node:assert/strict";
import { test } from "vitest";
import {
  isOriginalPassageQuotation,
  isOriginalSourceQuotation,
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
