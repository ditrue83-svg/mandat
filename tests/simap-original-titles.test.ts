import { describe, expect, it } from "vitest";
import { legacySimapRevision, normalizeSimap } from "../src/sources/simap";

// Entirely invented fixtures; no archived tender or company data.
const projectId = "11111111-1111-4111-8111-111111111111";
const publicationId = "22222222-2222-4222-8222-222222222222";
const sourceUrl = `https://www.simap.ch/it/project-detail/${projectId}`;
const detailUrl = `https://www.simap.ch/api/publications/v1/project/${projectId}/publication-details/${publicationId}`;
const entry = {
  id: projectId,
  raw: {
    id: projectId,
    publicationId,
    publicationDate: "2030-09-01",
    projectNumber: "SYNTHETIC-TITLES",
    pubType: "tender",
    processType: "open",
    title: {
      it: "Titolo dalla ricerca inventato",
      en: "Invented search title",
    },
    procOfficeName: { it: "Ente inventato" },
  },
};
function detail(
  title: unknown = {
    it: "Manutenzione dei mobili inventati",
    de: "Lieferung neuer erfundener Möbel",
    fr: "Réparation des meubles inventés",
    en: "Invented furniture repair",
  },
) {
  return {
    id: publicationId,
    type: "tender",
    "project-info": { title },
    dates: { offerDeadline: "2030-12-01T12:00:00+01:00" },
    procurement: {
      orderDescription: { it: "Riparazione di tavoli e sedie." },
      orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
    },
    terms: { termsNote: { it: "Condizione inventata." } },
  };
}

describe("Titoli originali simap", () => {
  it("conserva anche traduzioni discordanti, senza decidere la pertinenza o un conflitto", () => {
    const input = detail();
    const before = structuredClone({ entry, input });
    const publication = normalizeSimap(entry, input);
    expect(publication.originalTitles).toEqual([
      {
        language: "it",
        text: "Manutenzione dei mobili inventati",
        url: detailUrl,
        path: "project-info.title.it",
      },
      {
        language: "de",
        text: "Lieferung neuer erfundener Möbel",
        url: detailUrl,
        path: "project-info.title.de",
      },
      {
        language: "fr",
        text: "Réparation des meubles inventés",
        url: detailUrl,
        path: "project-info.title.fr",
      },
      {
        language: "en",
        text: "Invented furniture repair",
        url: detailUrl,
        path: "project-info.title.en",
      },
    ]);
    expect(publication.title).toBe("Manutenzione dei mobili inventati");
    expect(publication.originalText).not.toContain("Lieferung");
    expect(publication.reviewRequired).toBe(false);
    expect(publication).not.toHaveProperty("score");
    expect({ entry, input }).toEqual(before);
  });

  it("aggiunge solo originalTitles allo stesso raw senza cambiare nessun campo preesistente", () => {
    const publication = normalizeSimap(entry, detail());
    const { originalTitles, ...previousFields } = publication;
    expect(originalTitles).toHaveLength(4);
    // Captured from the previous normalizer before adding originalTitles.
    expect(previousFields).toEqual({
      id: `simap-${projectId}`,
      externalId: projectId,
      projectId,
      canonicalKey: "simap:SYNTHETIC-TITLES",
      source: "simap",
      title: "Manutenzione dei mobili inventati",
      buyer: "Ente inventato",
      location: "Lugano",
      canton: "TI",
      zone: "Luganese",
      publishedAt: "2030-08-31T22:00:00.000Z",
      updatedAt: "2030-08-31T22:00:00.000Z",
      visibleAt: "2030-09-01T06:00:00.000Z",
      deadline: "2030-12-01T11:00:00.000Z",
      valueChf: null,
      procedure: "Concorso pubblico",
      status: "open",
      sectors: ["manutenzioni"],
      cpv: [],
      sourceUrl,
      sourceUrls: [sourceUrl],
      originalText:
        "Manutenzione dei mobili inventati\n\nRiparazione di tavoli e sedie.\n\nCondizione inventata.",
      originalDescriptions: [
        {
          language: "it",
          text: "Riparazione di tavoli e sedie.",
          url: detailUrl,
        },
      ],
      sourceConditions: [],
      summary: null,
      requirements: [],
      evidence: [
        {
          url: sourceUrl,
          field: "Oggetto",
          quote: "Riparazione di tavoli e sedie.",
        },
        {
          url: sourceUrl,
          field: "Scadenza",
          quote: "2030-12-01T12:00:00+01:00",
        },
      ],
      documents: [],
      reviewRequired: false,
      reviewReasons: [],
      revision:
        "simap-v2:9bd1876a91d77468dc81389d6167d757b42dd62c895820b853dd1e643028e767",
    });
    expect(legacySimapRevision(publication)).toBe(
      "de4bc8167f9cc30bde62ca8ac3916e9588d3f43fde323844f3df33e23dd97158",
    );
  });

  it("usa solo le traduzioni del dettaglio quando almeno una è utilizzabile", () => {
    const publication = normalizeSimap(
      entry,
      detail({ it: null, de: "Erfundene Möbelreparatur", en: " " }),
    );
    expect(publication.originalTitles).toEqual([
      {
        language: "de",
        text: "Erfundene Möbelreparatur",
        url: detailUrl,
        path: "project-info.title.de",
      },
    ]);
    expect(
      publication.originalTitles?.some(({ language }) => language === "it"),
    ).toBe(false);
  });

  it.each(
    [
      null,
      " ",
      {},
      [],
      42,
      false,
      { it: null, de: 2, fr: {}, en: "<p> </p>" },
      { rm: "Titolo non classificato" },
    ].map((title) => ({ title })),
  )(
    "ripiega sull’entry solo se il dettaglio non contiene titoli utilizzabili: $title",
    ({ title }) => {
      const publication = normalizeSimap(entry, detail(title));
      // The entry may come from search or a header refresh. Its exact request URL
      // is unavailable, so this is a project page link, not a detail API citation.
      expect(publication.originalTitles).toEqual([
        {
          language: "it",
          text: "Titolo dalla ricerca inventato",
          url: sourceUrl,
          path: "entry.title.it",
        },
        {
          language: "en",
          text: "Invented search title",
          url: sourceUrl,
          path: "entry.title.en",
        },
      ]);
    },
  );

  it("usa il fallback anche quando manca project-info senza inferire la lingua", () => {
    const input = detail();
    const { "project-info": unused, ...withoutInfo } = input;
    void unused;
    const publication = normalizeSimap(
      { ...entry, raw: { ...entry.raw, title: "  Titolo senza lingua  " } },
      withoutInfo,
    );
    expect(publication.originalTitles).toEqual([
      {
        language: null,
        text: "Titolo senza lingua",
        url: sourceUrl,
        path: "entry.title",
      },
    ]);
  });

  it("converte HTML come le descrizioni senza tradurre o attribuire una lingua", () => {
    const publication = normalizeSimap(
      entry,
      detail(
        " <p>Tavoli &amp; sedie</p><script>hidden()</script><p>Riparazione</p> ",
      ),
    );
    expect(publication.originalTitles).toEqual([
      {
        language: null,
        text: "Tavoli & sedie\nRiparazione",
        url: detailUrl,
        path: "project-info.title",
      },
    ]);
  });

  it("conserva lingue note e ignora valori malformati senza cambiare la selezione del titolo", () => {
    const publication = normalizeSimap(
      entry,
      detail({ it: "   ", de: "Reparatur", fr: 8, en: false, rm: "Testo" }),
    );
    expect(publication.originalTitles).toEqual([
      {
        language: "de",
        text: "Reparatur",
        url: detailUrl,
        path: "project-info.title.de",
      },
    ]);
    // Preserve the existing translation selection even when it stops on blank it.
    expect(publication.title).toBe("Titolo dalla ricerca inventato");
  });

  it("mantiene ordine e fingerprint indipendenti dall’ordine delle lingue", () => {
    const first = normalizeSimap(
      entry,
      detail({ it: "Riparazione", de: "Lieferung" }),
    );
    const reordered = normalizeSimap(
      entry,
      detail({ de: "Lieferung", it: "Riparazione" }),
    );
    expect(reordered.originalTitles).toEqual(first.originalTitles);
    expect(reordered.revision).toBe(first.revision);
    const corrected = normalizeSimap(
      entry,
      detail({ it: "Riparazione", de: "Geänderte Lieferung" }),
    );
    expect(corrected.originalText).toBe(first.originalText);
    expect(corrected.revision).not.toBe(first.revision);
  });

  it("non attribuisce alla commessa i titoli di lotti diversi", () => {
    const publication = normalizeSimap(entry, {
      ...detail(),
      lots: [
        { title: { it: "Fornitura inventata del lotto A" } },
        { title: { it: "Trasporto inventato del lotto B" } },
      ],
    });
    expect(publication.originalTitles).toHaveLength(4);
    expect(
      publication.originalTitles?.every(({ path }) =>
        path.startsWith("project-info.title."),
      ),
    ).toBe(true);
    expect(JSON.stringify(publication.originalTitles)).not.toContain("lotto");
  });
});
