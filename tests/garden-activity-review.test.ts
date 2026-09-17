import { describe, expect, it } from "vitest";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import type { CompanyProfile, Publication } from "../src/lib/domain";
import { findGardenActivityReview } from "../src/lib/garden-activity-review";
import { preliminaryMatch } from "../src/lib/matching";
import { activityReviewForMatch } from "../src/lib/cpv-service-signals";

const now = new Date("2030-01-01T10:00:00Z");
const url = "https://example.invalid/descrizione";
function fixture(
  text: string,
  language: NonNullable<
    Publication["originalDescriptions"]
  >[number]["language"] = null,
) {
  const p: Publication = {
    ...getDemoOpportunities(now)[0],
    title: "Sistemazione esterna",
    originalText: "Dettagli negli allegati.",
    originalTitles: [],
    originalDescriptions: [{ text, language, url }],
    documentPages: [],
    summary: null,
    sectors: ["edilizia"],
    cpv: ["45000000"],
    canton: "TI",
    zone: "Luganese",
    valueChf: null,
    status: "open",
    visibleAt: "2029-01-01T07:00:00Z",
    deadline: "2031-01-01T10:00:00Z",
  };
  const profile: CompanyProfile = {
    ...demoProfile,
    sectors: ["giardinaggio"],
    activities: "Curiamo alberi, siepi e prati.",
    keywords: [],
    exclusions: [],
    zones: ["Tutto il Ticino"],
    minValue: null,
    maxValue: null,
  };
  return { p, profile };
}

describe("candidati parziali del verde", () => {
  it.each([
    [
      "de",
      "Lieferung und Pflanzung von Bäumen, zusätzlich Erdarbeiten und Drainagen.",
    ],
    ["fr", "Livraison et plantation d’arbres, avec terrassement et drainage."],
    ["it", "Piantumazione di alberi con scavi e drenaggi."],
    ["en", "Planting trees with earthworks and drainage."],
    ["de", "Pflege der Sträucher und Mahd der Rasenflächen."],
    ["fr", "L’ensemencement de prairies et la pose de clôtures."],
  ] as const)(
    "conserva una frase %s e il componente del profilo, solo alla revisione",
    (language, text) => {
      const { p, profile } = fixture(text, language);
      const result = preliminaryMatch(p, profile, now);
      expect(result).toMatchObject({
        eligible: true,
        score: 0,
        uncertain: true,
        activityReview: { version: "garden-activity-review-v1" },
      });
      const [s] = findGardenActivityReview(p, profile)!.signals;
      expect(s).toMatchObject({
        basis: "source_activity_terms",
        language,
        url,
        field: "originalDescriptions[0]",
      });
      expect(s).not.toHaveProperty("cpv");
      expect(text.slice(s.start, s.end)).toBe(s.quote);
      for (const term of Object.values(s.terms))
        expect(text.slice(term.start, term.end)).toBe(term.quote);
      expect(
        profile.activities.slice(
          s.profileEvidence.start,
          s.profileEvidence.end,
        ),
      ).toBe(s.profileEvidence.quote);
    },
  );
  it.each([
    "Allgemeine Bauleistungen.",
    "Eine Allee mit Bäumen. Wartung von Klimaanlagen.",
    "Bäume; Pflege von Innenräumen.",
    "Plantation_plastique d’arbres artificiels.",
    "Baumaterial und Softwarepflege.",
    "Livraison de matériaux et fourniture d’arbres.",
  ])(
    "non recupera un CPV generico o un frammento senza entrambe le parole: %s",
    (text) => {
      const { p, profile } = fixture(text);
      expect(findGardenActivityReview(p, profile)).toBeUndefined();
      expect(preliminaryMatch(p, profile, now).eligible).toBe(false);
    },
  );
  it("richiede un componente comune e il settore giardinaggio nel profilo", () => {
    const { p, profile } = fixture("Planting trees.");
    profile.activities = "Curiamo esclusivamente tappeti erbosi.";
    expect(findGardenActivityReview(p, profile)).toBeUndefined();
    profile.activities = "Cura di alberi";
    profile.sectors = ["manutenzioni"];
    expect(findGardenActivityReview(p, profile)).toBeUndefined();
  });
  it("ignora sintesi, titoli di file e nome dell’ente; conserva pagina e Unicode originale", () => {
    const { p, profile } = fixture("");
    const text = "🌳 E\u0301lagage des arbres et terrassement.";
    p.summary = text;
    p.buyer = text;
    p.documents = [{ title: text, url, requiresLogin: true }];
    expect(findGardenActivityReview(p, profile)).toBeUndefined();
    p.documentPages = [{ text, url: `${url}.pdf`, page: 7 }];
    const [s] = findGardenActivityReview(p, profile)!.signals;
    expect(s).toMatchObject({
      page: 7,
      field: "documentPages[0]",
      url: `${url}.pdf`,
      language: null,
      lexiconLanguage: "fr",
    });
    expect(s.terms.operation.quote).toBe("E\u0301lagage");
    expect(text.slice(s.terms.operation.start, s.terms.operation.end)).toBe(
      "E\u0301lagage",
    );
  });
  it("non presenta una co-occorrenza negata o opzionale come lavoro accertato", () => {
    for (const text of [
      "La plantation d’arbres est exclue.",
      "Optional: planting trees.",
    ]) {
      const { p, profile } = fixture(text);
      const r = preliminaryMatch(p, profile, now);
      expect(r).toMatchObject({ eligible: true, score: 0, uncertain: true });
      expect(r.activityReview!.signals[0].quote).toBe(text.slice(0, -1));
      expect(r.reason).toContain("verificare");
    }
  });
  it("applica prima tutti i vincoli operativi e le esclusioni dichiarate", () => {
    const changes: Partial<Publication>[] = [
      { status: "cancelled" },
      { deadline: "2029-01-01T10:00:00Z" },
      { visibleAt: "2031-01-01T07:00:00Z" },
      { canton: "BE" },
      { zone: "Bellinzonese" },
      { valueChf: 500 },
      { originalText: "Presenza di amianto." },
    ];
    for (const change of changes) {
      const { p, profile } = fixture("Planting trees.");
      profile.exclusions = ["amianto"];
      profile.zones = ["Luganese"];
      profile.minValue = 1000;
      expect(preliminaryMatch({ ...p, ...change }, profile, now)).toMatchObject(
        { eligible: false, score: 0 },
      );
    }
  });
  it("mantiene la revisione dopo l’arricchimento dei settori della sintesi", () => {
    const { p, profile } = fixture("Planting trees and earthworks.");
    p.sectors.push("giardinaggio");
    const preliminary = preliminaryMatch(p, profile, now);
    expect(preliminary.activityReview).toBeDefined();
    expect(
      activityReviewForMatch({
        publication: p,
        sectors: profile.sectors,
        activities: profile.activities,
        preliminary,
        revision: `${p.revision}:profile-v1:ready:model:true:activity-review:garden-activity-review-v1:hash`,
        profileRevision: "profile-v1",
      })?.version,
    ).toBe("garden-activity-review-v1");
  });
});
