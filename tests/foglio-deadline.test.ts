import { expect, it } from "vitest";
import { normalizeFoglio } from "../src/sources/foglio";

function publication(deadline: string) {
  return normalizeFoglio(`<publication><meta>
<id>274fc2e7-5586-459b-b3a1-7bc2f79a8721</id>
<publicationNumber>OB-TI10-LOCAL</publicationNumber><subRubric>OB-TI10</subRubric>
<publicationDate>2026-03-01</publicationDate><publicationState>PUBLISHED</publicationState>
<title><it>Bando - Pulizia dei locali inventati</it></title>
</meta><content><publication><![CDATA[
Pulizia ordinaria dei locali inventati.
Presentazione dell'offerta: ${deadline}
Luogo di esecuzione: Lugano
]]></publication></content></publication>`);
}

it.each(["29.03.2026 02:30", "25.10.2026 02:30"])(
  "non sceglie un istante per la scadenza Foglio non univoca %s",
  (value) => {
    const p = publication(value);
    expect(p.status).toBe("open");
    expect(p.deadline).toBeNull();
    expect(p.reviewRequired).toBe(true);
    expect(p.reviewReasons).toContain(
      "Termine di presentazione da verificare sul PDF ufficiale",
    );
    expect(p.evidence.some((e) => e.field === "Scadenza")).toBe(false);
  },
);

it.each([
  ["29.03.2026 03:30", "2026-03-29T01:30:00.000Z"],
  ["25.10.2026 03:30", "2026-10-25T02:30:00.000Z"],
  ["20.10.2026 12:00", "2026-10-20T10:00:00.000Z"],
])("conserva la scadenza locale Foglio univoca %s", (value, expected) => {
  const p = publication(value);
  expect(p.deadline).toBe(expected);
  expect(p.reviewRequired).toBe(false);
  expect(p.evidence).toContainEqual({
    field: "Scadenza",
    url: p.sourceUrl,
    quote: `Presentazione dell'offerta: ${value}`,
  });
});
