import { describe, expect, it } from "vitest";
import {
  classifyProcurement,
  classifyPublication,
  withClassification,
  classificationReviewPending,
  classificationReviewSuffix,
  type ClassificationInput,
} from "../src/lib/sector-classification";
import {
  SECTORS,
  BETA_PRIORITY_SECTORS,
  sectorFilter,
  matchesSectorFilter,
  sectorCaption,
  type Sector,
} from "../src/lib/sectors";
import { profileSearchSchema } from "../src/lib/validation";
import { getDemoOpportunities, demoProfile } from "../src/lib/demo";
import { preliminaryMatch } from "../src/lib/matching";
import { activityReviewBlocksAutomatic } from "../src/lib/cpv-service-signals";
import cpv from "../src/lib/sector-cpv-reference.json";

const classify = (
  title: string,
  mainCpv: string | null = null,
  description = "",
  additionalCpv: string[] = [],
) =>
  classifyProcurement({
    titles: [title],
    descriptions: [description],
    mainCpv,
    additionalCpv,
  });

describe("catalogue taxonomy", () => {
  it("has stable original IDs, explicit beta priorities and no pseudo-sector", () => {
    expect(new Set(SECTORS.map((s) => s.id)).size).toBe(SECTORS.length);
    expect(BETA_PRIORITY_SECTORS).toEqual([
      "pulizie",
      "giardinaggio",
      "manutenzioni",
      "edilizia",
      "impianti",
      "sicurezza",
      "catering",
      "trasporti",
    ]);
    expect(SECTORS.find((s) => s.id === "edilizia")?.label).toBe(
      "Edilizia e opere civili",
    );
    expect(SECTORS.some((s) => (s.id as string) === "da-classificare")).toBe(
      false,
    );
    expect(
      profileSearchSchema.safeParse({
        sectors: ["edilizia"],
        zones: ["Tutto il Ticino"],
      }).success,
    ).toBe(true);
    expect(
      profileSearchSchema.safeParse({
        sectors: ["informatica", "assicurazioni"],
        zones: ["Tutto il Ticino"],
      }).success,
    ).toBe(true);
    expect(
      profileSearchSchema.safeParse({
        sectors: ["da-classificare"],
        zones: ["Tutto il Ticino"],
      }).success,
    ).toBe(false);
  });
  it.each<[string, string, Sector]>([
    ["Pulizia edifici", "90910000", "pulizie"],
    ["Cura giardini", "77310000", "giardinaggio"],
    ["Manutenzione periodica", "50700000", "manutenzioni"],
    ["Opere stradali", "45233120", "edilizia"],
    ["Installazione quadri elettrici", "45310000", "impianti"],
    ["Servizio di vigilanza", "79710000", "sicurezza"],
    ["Servizio mensa", "55510000", "catering"],
    ["Trasporto passeggeri", "60100000", "trasporti"],
    ["Progettazione strada", "71322000", "progettazione"],
    ["Fornitura di materiale CISCO", "32422000", "informatica"],
    ["Assicurazione LAINF complementare", "66512100", "assicurazioni"],
    ["Fornitura arredi", "39180000", "arredi"],
    ["Abbigliamento tecnico di polizia", "18130000", "abbigliamento"],
    ["Acquisto carburanti per distributori", "09132100", "energia"],
    ["Fornitura tubi in ghisa", "44161200", "materiali"],
    ["Fornitura di veicoli", "34100000", "veicoli"],
    ["Fornitura glucometri", "33124110", "sanita"],
    ["Smaltimento scarti vegetali", "90513100", "ambiente"],
    ["Fornitura generi alimentari", "15000000", "alimentari"],
    ["Fornitura cancelleria", "30199000", "ufficio"],
    ["Servizi alberghieri", "55100000", "ospitalita"],
    ["Consulenza aziendale", "79400000", "consulenza"],
  ])("classifies %s by its public subject", (title, code, sector) => {
    expect(classify(title, code).sectors).toEqual([sector]);
  });
  it("binds mapping roots and supported codes to the official CPV vocabulary", () => {
    expect(cpv.reference).toBe("https://ted.europa.eu/it/simap/cpv");
    expect(cpv.sourceXmlSha256).toMatch(/^[a-f0-9]{64}$/);
    for (const rule of cpv.rules) {
      expect(rule.code.slice(0, 8)).toBe(rule.prefix.padEnd(8, "0"));
      expect(cpv.validCodes).toContain(rule.code.slice(0, 8));
      expect(SECTORS.some((s) => s.id === rule.sector)).toBe(true);
      expect(rule.label.length).toBeGreaterThan(5);
    }
  });
});

describe("procurement subject rather than incidental words", () => {
  it("flags construction CPV conflicting with replacement of an electrical control unit", () => {
    expect(
      classify(
        "Rinnovo dispositivo di comando della funivia",
        "45234250",
        "Nuovo controllo elettrico completo.",
      ),
    ).toMatchObject({
      sectors: [],
      needsClassification: true,
      reasons: ["conflicting_information"],
    });
    expect(
      classify(
        "Schermature",
        "44115900",
        "Fornitura e posa di lamelle esterne.",
      ).kinds,
    ).toEqual(["installation", "supply"]);
    expect(
      classify(
        "Progettazione degli impianti",
        "71320000",
        "Progettazione della fornitura e posa.",
      ).kinds,
    ).toEqual(["design"]);
  });
  it("does not invent a transport service from delivery clauses with no CPV", () => {
    expect(
      classify(
        "Fornitura n. 17",
        null,
        "Trasporto e consegna compresi nel prezzo.",
      ),
    ).toMatchObject({ sectors: [], needsClassification: true });
  });
  it("does not add IT from generic cable installation or an ancillary solar component", () => {
    expect(
      classify(
        "Cablaggio elettrico",
        "45311100",
        "Posa cavi di bassa tensione.",
        ["44320000", "45314300", "45314310"],
      ).sectors,
    ).toEqual(["impianti"]);
    expect(
      classify(
        "Impianti fotovoltaici",
        "45000000",
        "Fornitura e posa dei pannelli fotovoltaici.",
        ["09331200", "32571000", "45261215"],
      ).sectors,
    ).toEqual(["impianti"]);
    expect(
      classify(
        "Approvvigionamento di energia elettrica",
        "09310000",
        "Fornitura di energia elettrica 60 GWh/anno.",
        ["31682000", "65300000"],
      ).sectors,
    ).toEqual(["energia"]);
  });
  it("does not merge contradictory translated subjects into a confident category", () => {
    const c = classifyProcurement({
      titles: ["Fornitura di computer", "Fourniture de vêtements"],
      descriptions: [],
      mainCpv: "30200000",
      additionalCpv: [],
    });
    expect(c).toMatchObject({
      sectors: [],
      needsClassification: true,
      reasons: ["conflicting_information"],
    });
  });
  it("flags repeated current-lot descriptions for unrelated subjects", () => {
    expect(
      classify(
        "Cablaggio elettrico",
        "45311100",
        "Il presente lotto comprende:\nFornitura della fibra ottica.\nIl lotto attuale comprende:\nPosa della rete elettrica.",
      ),
    ).toMatchObject({
      sectors: [],
      needsClassification: true,
      reasons: ["conflicting_information"],
    });
  });
  it.each([
    [
      "Prestazioni da ingegnere civile per la strada Corognola–al Gropp",
      "71322000",
      "Realizzazione dei lavori: fasi di progettazione e direzione lavori.",
      ["progettazione"],
    ],
    [
      "Fornitura di materiale CISCO",
      "32422000",
      "L’ospedale richiede trasporto incluso, sicurezza sul lavoro e manutenzione.",
      ["informatica"],
    ],
    [
      "Gestione del portafoglio assicurativo",
      "66518100",
      "La sicurezza della flotta del corpo di polizia.",
      ["assicurazioni"],
    ],
    [
      "Fornitura e posa di mobilio – arredi laboratori nell’ambito del restauro e della ristrutturazione",
      "39180000",
      "Nell'edificio sono presenti impianti elettrici.",
      ["arredi"],
    ],
    [
      "Fornitura di abbigliamento tecnico della polizia",
      "18130000",
      "Trasporto e consegna compresi. Sicurezza dei collaboratori.",
      ["abbigliamento"],
    ],
    [
      "Fornitura di carburanti per Monte Carasso e Bodio",
      "09134100",
      "Trasporto, consegna e sicurezza dei distributori.",
      ["energia"],
    ],
    [
      "Fornitura pompe infusionali e pompe a siringa",
      "42122410",
      "Consegna al centro sanitario.",
      ["sanita"],
    ],
    [
      "Cadenazzo, centro di manutenzione",
      "71000000",
      "Progettazione generale di un centro di manutenzione dei binari e degli impianti di sicurezza.",
      ["progettazione"],
    ],
  ])("corrects %s", (title, code, description, expected) => {
    expect(
      classify(title as string, code as string, description as string).sectors,
    ).toEqual(expected);
  });
  it("keeps main/additional CPV roles and genuine mixed services", () => {
    const result = classify(
      "Fornitura mobili e computer",
      "39100000",
      "Fornitura di mobili e computer.",
      ["30200000"],
    );
    expect(result.sectors).toEqual(["informatica", "arredi"]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        { sector: "arredi", basis: "main_cpv", value: "39100000" },
        { sector: "informatica", basis: "additional_cpv", value: "30200000" },
      ]),
    );
    expect(
      classify("Servizi di pulizia e trasporto scolastico", "90910000", "", [
        "60130000",
      ]).sectors,
    ).toEqual(["pulizie", "trasporti"]);
  });
  it.each([
    ["Ingenieurleistungen für eine Strasse", "71300000", "progettazione"],
    ["Fourniture de mobilier pour les laboratoires", "39180000", "arredi"],
    ["Medical equipment for a school", "33100000", "sanita"],
    ["Dienstleistungen: Gebäudereinigung", null, "pulizie"],
    ["Attrezzature tecniche per eventi", null, "ospitalita"],
  ])("supports original-language objects: %s", (title, code, sector) =>
    expect(classify(title, code).sectors).toEqual([sector]),
  );
  it("does not turn sparse, invalid or contradictory information into a category", () => {
    expect(classify("Lotto 3: altri accessori").sectors).toEqual([]);
    expect(classify("Secondo capitolato", "99999999").reasons).toEqual([
      "unsupported_cpv",
    ]);
    expect(classify("Servizio lavanderia", "55100000").reasons).toEqual([
      "conflicting_information",
    ]);
    expect(
      classify("Opere da impresario costruttore", "44130000").sectors,
    ).toEqual([]);
    expect(classify("Fornitura di arredi", "79710000").sectors).toEqual([]);
  });
  it("separates work, design, supply, installation and maintenance", () => {
    expect(classify("Prestazioni ingegnere civile", "71300000").kinds).toEqual([
      "design",
    ]);
    expect(classify("Lavori di costruzione", "45000000").kinds).toEqual([
      "works",
    ]);
    expect(classify("Fornitura e posa di mobilio", "39100000").kinds).toEqual([
      "installation",
      "supply",
    ]);
    expect(classify("Manutenzione software", "72267000").sectors).toEqual([
      "informatica",
    ]);
    expect(classify("Manutenzione software", "72267000").kinds).toContain(
      "maintenance",
    );
  });
  it("is reproducible under harmless object/order changes", () => {
    const input: ClassificationInput = {
      titles: ["Arredi", "Fornitura mobili"],
      descriptions: ["Consegna mobili"],
      mainCpv: "39100000",
      additionalCpv: ["30200000", "39100000"],
    };
    const other = {
      ...input,
      titles: [...input.titles].reverse(),
      additionalCpv: [...input.additionalCpv].reverse(),
    };
    expect(classifyProcurement(input)).toEqual(classifyProcurement(other));
  });
});

describe("derived classification and Radar safeguards", () => {
  const original = {
    ...getDemoOpportunities(new Date("2030-01-01"))[0],
    source: "simap" as const,
    title: "Fornitura materiale CISCO",
    cpv: ["32422000"],
    sectors: ["impianti"] as Sector[],
    summary: "Testo AI: edilizia e pulizie",
    originalText: "Clausole sulla sicurezza e consegna con trasporto",
  };
  it("does not mutate source data or use summary, buyer, terms or old categories", () => {
    const before = JSON.stringify(original);
    const result = withClassification(original);
    expect(result.sectors).toEqual(["informatica"]);
    expect(JSON.stringify(original)).toBe(before);
    expect(result.revision).toBe(original.revision);
    expect(result.sourceUrl).toBe(original.sourceUrl);
  });
  it("keeps lot subjects separate without inheriting a parent category", () => {
    const result = classifyPublication(original, {
      projectSections: { procurement: { cpvCode: { code: "32422000" } } },
      directory: [
        { id: "a", number: 1 },
        { id: "b", number: 2 },
        { id: "c", number: 3 },
      ],
      lotField: {
        lots: [
          {
            id: "a",
            title: { it: "Fornitura mobili" },
            cpvCode: { code: "39100000" },
          },
          {
            id: "b",
            title: { de: "Reinigung" },
            cpvCode: { code: "90910000" },
          },
          { id: "c", title: { it: "Altri accessori" } },
        ],
      },
    });
    expect(result.sectors).toEqual(["pulizie", "arredi"]);
    expect(result.lots.map((l) => l.sectors)).toEqual([
      ["arredi"],
      ["pulizie"],
      [],
    ]);
    expect(result.needsClassification).toBe(true);
    expect(
      matchesSectorFilter(
        result.sectors,
        "da-classificare",
        result.needsClassification,
      ),
    ).toBe(true);
    expect(sectorCaption(result.sectors, result.needsClassification)).toContain(
      "Da classificare: alcuni lotti",
    );
  });
  it("defines the unclassified filter consistently and preserves old links", () => {
    expect(sectorFilter("edilizia")).toBe("edilizia");
    expect(sectorFilter("informatica")).toBe("informatica");
    expect(sectorFilter("da-classificare")).toBe("da-classificare");
    expect(matchesSectorFilter([], "all")).toBe(true);
    expect(matchesSectorFilter([], "da-classificare")).toBe(true);
    expect(matchesSectorFilter(["informatica"], "da-classificare")).toBe(false);
    expect(sectorCaption([])).toBe("Da classificare");
  });
  it("blocks stale legacy admission/notifications and requires an exact new review", () => {
    const profile = {
      ...demoProfile,
      sectors: ["informatica"] as Sector[],
      keywords: [],
      exclusions: [],
    };
    const before = JSON.stringify(profile);
    const pre = preliminaryMatch(original, profile, new Date("2030-01-01"));
    expect(pre.classificationReview).toBeTruthy();
    const old = {
      revision: original.revision + ":old",
      approved: true,
      reviewedAt: new Date(),
    };
    expect(classificationReviewPending(original, old.revision)).toBe(true);
    expect(
      activityReviewBlocksAutomatic(old, pre, {
        publication: original,
        profileRevision: "old",
      }),
    ).toBe(true);
    expect(
      classificationReviewPending(
        original,
        old.revision + classificationReviewSuffix(original),
      ),
    ).toBe(false);
    expect(
      classificationReviewPending(
        original,
        old.revision + ":sector-review:obsolete",
      ),
    ).toBe(true);
    const newlyReviewed = {
      ...old,
      revision:
        original.revision +
        ":current:ready:manual" +
        classificationReviewSuffix(original),
    };
    expect(
      activityReviewBlocksAutomatic(newlyReviewed, pre, {
        publication: original,
        profileRevision: "current",
      }),
    ).toBe(false);
    expect(
      activityReviewBlocksAutomatic(newlyReviewed, pre, {
        publication: original,
        profileRevision: "changed",
      }),
    ).toBe(true);
    expect(JSON.stringify(profile)).toBe(before);
  });
});
