import { afterEach, expect, it, vi } from "vitest";
import nodemailer from "nodemailer";
import type { LotNotice } from "../src/lib/lot-notice";
import {
  renderChangeContent,
  renderDigestContent,
} from "../src/lib/notification-content";

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => {
      throw new Error("SMTP is forbidden in rendering tests");
    }),
  },
}));

afterEach(() => {
  expect(nodemailer.createTransport).not.toHaveBeenCalled();
});

const appUrl = "https://radar.example.invalid";
const item = {
  id: "cleaning-example",
  title: "Pulizia aule e uffici",
  deadline: "2026-10-13T14:00:00Z",
  sourceUrl: "https://amtsblattportal.ch/api/v1/publications/example/pdf",
  reason: "Possibile interesse. Fonte: ‹Pulizia delle aule e degli uffici›",
  assessment: "ai" as const,
};
const notice = "Pubblicazione non ufficiale.";

it("shows repeated documentary text once while preserving variants, provenance and safe HTML", () => {
  const original = {
    label: "Titolo condiviso (IT)",
    text: "Trasporto scolastico inventato",
    rawPath: "/base/title/it",
    url: item.sourceUrl,
    value: "Trasporto scolastico inventato",
  };
  // Rendering fixture only; no fabricated review or validated-notice claim.
  const source = {
    renderSnapshot: {
      publicationId: item.id,
      title: item.title,
      status: "open",
      sourceUrl: item.sourceUrl,
    },
    scope: [
      {
        kind: "positive",
        target: { kind: "project", publicationId: item.id },
        render: {
          title: item.title,
          description: "Descrizione inventata",
          reason: item.reason,
          sourceUrl: item.sourceUrl,
          operational: {
            country: "CH",
            canton: "TI",
            zone: "Luganese",
            deadline: item.deadline,
            valueChf: null,
          },
          reviewReasons: [],
          sharedTexts: [
            original,
            { ...original, rawPath: "/project-info/title/it" },
            {
              ...original,
              text: "Trasporto <rettificato>",
              rawPath: "/procurement/title/it",
            },
            { ...original, label: "Titolo condiviso (FR)" },
          ],
        },
      },
    ],
  } as unknown as LotNotice;
  const before = structuredClone(source);
  const result = renderDigestContent([{ ...item, lotNotice: source }], appUrl);
  for (const text of [result.textBody, result.html]) {
    expect(
      text.split("Titolo condiviso (IT): Trasporto scolastico inventato"),
    ).toHaveLength(2);
    expect(text).toContain(
      "Titolo condiviso (FR): Trasporto scolastico inventato",
    );
    expect(text.split("Progetto intero")).toHaveLength(2);
  }
  expect(result.textBody).toContain("Trasporto <rettificato>");
  expect(result.html).toContain("Trasporto &lt;rettificato&gt;");
  expect(result.html).not.toContain("<rettificato>");
  expect(result.html).toContain(`href="${item.sourceUrl}">Fonte originale</a>`);
  expect(result.textBody).toContain(`Fonte originale: ${item.sourceUrl}`);
  expect(source).toEqual(before);
});

it("preserva fonti e citazioni e distingue valutazioni AI e revisionate nelle due parti del digest", () => {
  const reviewed = {
    ...item,
    id: "reviewed-example",
    title: "Pulizia edificio comunale",
    sourceUrl: "https://www.simap.ch/example-publication",
    assessment: "reviewed" as const,
    reason: "Citazione conservata: ‹Pulizia ordinaria dell’edificio›",
  };
  const rendered = renderDigestContent([item, reviewed], appUrl);
  expect(rendered.html).toContain("2 nuove opportunità");
  for (const label of [
    "Valutazione Mandat · Pertinenza stimata dall’AI",
    "Valutazione Mandat · Pertinenza revisionata",
  ]) {
    expect(rendered.textBody).toContain(label);
    expect(rendered.html).toContain(`<strong>${label}</strong>`);
  }
  for (const original of [item, reviewed]) {
    expect(rendered.textBody).toContain(original.title);
    expect(rendered.textBody).toContain(original.reason);
    expect(rendered.html).toContain(`<p>${original.reason}</p></div>`);
    expect(rendered.textBody).toContain(`Fonte: ${original.sourceUrl}`);
    expect(rendered.html).toContain(`href="${original.sourceUrl}"`);
    expect(rendered.textBody).toContain(`${appUrl}/bandi/${original.id}`);
    expect(rendered.html).toContain(`href="${appUrl}/bandi/${original.id}"`);
  }
  for (const part of [rendered.textBody, rendered.html]) {
    expect(part.split(notice)).toHaveLength(2);
    expect(part).toContain("16:00");
    expect(part).toContain("ora svizzera");
  }
});

it("mantiene la scadenza mancante senza inventare una data o cambiare il motivo", () => {
  const rendered = renderDigestContent([{ ...item, deadline: null }], appUrl);
  expect(rendered.textBody).toContain("Scadenza: Non indicata");
  expect(rendered.html).toContain("Scadenza: Non indicata");
  expect(rendered.textBody).toContain(item.reason);
  expect(rendered.html).toContain("Una nuova opportunità");
});

it("rende innocui HTML e attributi nel digest senza alterare il testo semplice", () => {
  const untrusted = {
    ...item,
    id: 'example" onclick="bad()',
    title: '<img src=x onerror="bad()"> & gara',
    reason: "<script>bad()</script> Fonte: ‹A & B›",
    sourceUrl: 'https://amtsblattportal.ch/example?x="&y=1',
  };
  const rendered = renderDigestContent([untrusted], appUrl);
  expect(rendered.html).not.toContain("<script>");
  expect(rendered.html).not.toContain("<img");
  expect(rendered.html).not.toContain(' onclick="');
  expect(rendered.html).toContain(
    "&lt;script&gt;bad()&lt;/script&gt; Fonte: ‹A &amp; B›",
  );
  expect(rendered.html).toContain("?x=&quot;&amp;y=1");
  expect(rendered.html).toContain("example&quot; onclick=&quot;bad()");
  expect(rendered.textBody).toContain(untrusted.title);
  expect(rendered.textBody).toContain(untrusted.reason);
  expect(rendered.textBody).toContain(untrusted.sourceUrl);
});

it.each([
  ["open", "aperto"],
  ["cancelled", "annullato"],
  ["awarded", "aggiudicato"],
  ["closed", "chiuso"],
] as const)(
  "l’avviso %s mantiene stato, fonte e natura non ufficiale in HTML e testo",
  (status, label) => {
    const rendered = renderChangeContent({ ...item, status });
    for (const part of [rendered.textBody, rendered.html]) {
      expect(part).toContain(`«${item.title}»`);
      expect(part).toContain(`Stato: ${label}`);
      expect(part).toContain("16:00");
      expect(part).toContain("ora svizzera");
      expect(part.split(notice)).toHaveLength(2);
      expect(part).toContain(item.sourceUrl);
    }
    expect(rendered.html).toContain(`href="${item.sourceUrl}"`);
    expect(rendered.textBody).not.toContain("Valutazione Mandat");
  },
);

it("sanifica l’avviso HTML mantenendo titolo e URL originali nella parte testuale", () => {
  const publication = {
    ...item,
    status: "cancelled" as const,
    title: '<svg onload="bad()"> & annullamento',
    sourceUrl: 'https://amtsblattportal.ch/example?x="&y=1',
    deadline: null,
  };
  const rendered = renderChangeContent(publication);
  expect(rendered.html).not.toContain("<svg");
  expect(rendered.html).not.toContain(' onload="');
  expect(rendered.html).toContain(
    "&lt;svg onload=&quot;bad()&quot;&gt; &amp; annullamento",
  );
  expect(rendered.html).toContain("?x=&quot;&amp;y=1");
  expect(rendered.textBody).toContain(publication.title);
  expect(rendered.textBody).toContain(publication.sourceUrl);
  expect(rendered.textBody).toContain("Scadenza attuale: Non indicata");
});
