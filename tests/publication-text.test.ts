import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { publicationTextBlocks } from "../src/lib/publication-text";
import { PublicationText } from "../src/components/publication-text";

describe("source text presentation", () => {
  it("separates flattened numbered chapters without changing a character", () => {
    const text =
      "1. Committente Comune di Lumino. 2. Genere di procedura Procedura libera. 3. Oggetto della commessa Fasi 4.32 e 4.53. 9. Termini Entro le 12:00 del 09.11.2026. 10. Sopralluogo Non obbligatorio.";
    const blocks = publicationTextBlocks(text);
    expect(
      blocks.filter((b) => b.kind === "heading").map((b) => b.text),
    ).toEqual([
      "1. Committente",
      "2. Genere di procedura",
      "3. Oggetto della commessa",
      "9. Termini",
      "10. Sopralluogo",
    ]);
    expect(blocks.map((b) => b.text).join("")).toBe(text);
  });
  it.each([
    "Prezzo CHF 500’000.–; 25%; artt. 5 e 7. SIA 103:2020, fasi 4.32–4.53, km 6.357.",
    "Consegna 09.11.2026 ore 12:00. Vedere punto 9. Termini nel capitolato.",
    "La citazione 4. Oggetto rinvia a 2. Committente: non è un elenco ordinato.",
  ])(
    "does not turn values or isolated references into chapters: %s",
    (text) => {
      expect(
        publicationTextBlocks(text).every((b) => b.kind === "paragraph"),
      ).toBe(true);
      expect(
        publicationTextBlocks(text)
          .map((b) => b.text)
          .join(""),
      ).toBe(text);
    },
  );
  it.each(["\n", "\r\n", "\r"])(
    "preserves paragraphs, lists and source line endings %j",
    (newline) => {
      const text = `  Requisiti:${newline}Non sono ammesse varianti.${newline}${newline}- Prova A${newline}• Prova B${newline}Ultima riga  `;
      expect(
        publicationTextBlocks(text)
          .map((b) => b.text)
          .join(""),
      ).toBe(text);
    },
  );
  it("emphasizes existing headings and escapes untrusted source markup", () => {
    const html = renderToStaticMarkup(
      createElement(PublicationText, {
        lang: "de",
        text: "Anforderungen:\n<script>alert(1)</script> & obbligo",
      }),
    );
    expect(html).toContain("<strong>Anforderungen:</strong>");
    expect(html).toContain('lang="de"');
    expect(html).toContain(
      "&lt;script&gt;alert(1)&lt;/script&gt; &amp; obbligo",
    );
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<p>\n</p>");
  });
  it("recognizes original PDF nonbreaking spaces and uppercase labels", () => {
    const text =
      "1.\u00a0 COMMITTENTE\nComune.\n2.\u00a0 Genere di procedura\nProcedura libera.";
    const blocks = publicationTextBlocks(text);
    expect(blocks.filter((b) => b.kind === "heading")).toHaveLength(2);
    expect(blocks.map((b) => b.text).join("")).toBe(text);
  });
  it("handles empty text", () => expect(publicationTextBlocks("")).toEqual([]));
});
