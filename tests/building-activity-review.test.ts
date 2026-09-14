import { describe, expect, it } from "vitest";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import type { CompanyProfile, Publication } from "../src/lib/domain";
import { findBuildingActivityReview } from "../src/lib/building-activity-review";
import { activityReviewForMatch } from "../src/lib/cpv-service-signals";
import { preliminaryMatch } from "../src/lib/matching";

const now = new Date("2030-01-01T10:00:00Z");
const url = "https://example.invalid/original";
function fixture(text: string, title = false) {
  const original = { text, language: "de" as const, url };
  const p: Publication = {
    ...getDemoOpportunities(now)[0],
    title: "Lavori edili",
    originalText: "Dettagli negli allegati.",
    originalTitles: title ? [{ ...original, path: "project-info.title" }] : [],
    originalDescriptions: title ? [] : [original],
    documentPages: [],
    documents: [],
    summary: null,
    sectors: ["edilizia"],
    cpv: ["45210000"],
    canton: "TI",
    zone: "Luganese",
    valueChf: null,
    status: "open",
    visibleAt: "2029-01-01T07:00:00Z",
    deadline: "2031-01-01T10:00:00Z",
  };
  const profile: CompanyProfile = {
    ...demoProfile,
    sectors: ["manutenzioni"],
    activities: "🔧 Ripariamo PORTE, serrature e cancelli.",
    keywords: [],
    exclusions: [],
    zones: ["Tutto il Ticino"],
    minValue: null,
    maxValue: null,
  };
  return { p, profile };
}
describe("componenti e interventi negli originali", () => {
  it.each([
    ["Manutenzione di porte e posa di vetrate.", false],
    [
      "Instandhaltung historischer Türen mit zusätzlichen Elektroinstallationen.",
      false,
    ],
    ["Rénovation des portes et installation de fenêtres.", false],
    ["Repair of locks and installation of access equipment.", false],
    ["Wartung der Tore.", false],
    ["Schulanlage: Instandsetzung – BKP 273.0 Innentüren aus Holz", true],
  ])(
    "conserva il contesto originale solo alla revisione: %s",
    (text, title) => {
      const { p, profile } = fixture(text as string, title as boolean);
      const r = preliminaryMatch(p, profile, now);
      expect(r).toMatchObject({
        eligible: true,
        score: 0,
        uncertain: true,
        activityReview: { version: "building-activity-review-v1" },
      });
      const [signal] = findBuildingActivityReview(p, profile)!.signals;
      expect((text as string).slice(signal.start, signal.end)).toBe(
        signal.quote,
      );
      expect(signal).toMatchObject({
        url,
        basis: "source_building_activity_terms",
        profileEvidence: { field: "activities" },
      });
      expect(signal).not.toHaveProperty("cpv");
      for (const term of Object.values(signal.terms))
        expect((text as string).slice(term.start, term.end)).toBe(term.quote);
      expect(
        profile.activities.slice(
          signal.profileEvidence.start,
          signal.profileEvidence.end,
        ),
      ).toBe(signal.profileEvidence.quote);
    },
  );
  it.each([
    "Türen. Wartung von Lüftungsanlagen.",
    "Türen; Reparatur von Büromöbeln.",
    "Türsoftware und Reparaturverwaltung.",
    "Installation of door_support software.",
    "BKP 273.0 Innentüren aus Holz",
    "Allgemeine Instandsetzung.",
  ])("non associa parole isolate o composti: %s", (text) => {
    const { p, profile } = fixture(text);
    expect(findBuildingActivityReview(p, profile)).toBeUndefined();
    expect(preliminaryMatch(p, profile, now).eligible).toBe(false);
  });
  it("conserva negazioni, opzioni e co-occorrenze senza attribuire un ruolo", () => {
    for (const text of [
      "La réparation des portes est exclue.",
      "Optional: repair of doors by a separate contractor.",
      "Les portes restent inchangées pendant la rénovation des sols.",
    ]) {
      const { p, profile } = fixture(text);
      const r = preliminaryMatch(p, profile, now);
      expect(r).toMatchObject({ eligible: true, uncertain: true, score: 0 });
      expect(r.activityReview!.signals[0].quote).toBe(text.slice(0, -1));
    }
  });
  it("lega gli offset al testo Unicode originale senza normalizzare la citazione", () => {
    const text = "🔧 Re\u0301paration des portes.";
    const { p, profile } = fixture(text);
    const [signal] = findBuildingActivityReview(p, profile)!.signals;
    expect(signal.terms.operation.quote).toBe("Re\u0301paration");
    expect(
      text.slice(signal.terms.operation.start, signal.terms.operation.end),
    ).toBe("Re\u0301paration");
    expect(
      profile.activities.slice(
        signal.profileEvidence.start,
        signal.profileEvidence.end,
      ),
    ).toBe("PORTE");
  });
  it("richiede settore e componente del profilo; ignora i metadati e le sintesi", () => {
    const { p, profile } = fixture("");
    const text = "Wartung der Türen";
    Object.assign(p, {
      title: text,
      originalText: text,
      summary: text,
      buyer: text,
      documents: [{ title: text, url, requiresLogin: false }],
    });
    expect(findBuildingActivityReview(p, profile)).toBeUndefined();
    p.originalDescriptions = [{ text, url, language: "de" }];
    profile.activities = "Manutenzione ascensori e supporti_porta.";
    expect(findBuildingActivityReview(p, profile)).toBeUndefined();
    profile.activities = "Riparazione porte";
    profile.sectors = ["edilizia"];
    expect(findBuildingActivityReview(p, profile)).toBeUndefined();
  });
  it("mantiene i vincoli operativi e le esclusioni prima del recupero", () => {
    const changes: Partial<Publication>[] = [
      { status: "awarded" },
      { deadline: "2029-01-01T10:00:00Z" },
      { visibleAt: "2031-01-01T07:00:00Z" },
      { canton: "BE" },
      { zone: "Bellinzonese" },
      { valueChf: 500 },
      { originalText: "Presenza di amianto." },
    ];
    for (const change of changes) {
      const { p, profile } = fixture("Instandhaltung der Türen.");
      profile.zones = ["Luganese"];
      profile.minValue = 1000;
      profile.exclusions = ["amianto"];
      expect(preliminaryMatch({ ...p, ...change }, profile, now)).toMatchObject(
        { eligible: false, score: 0 },
      );
    }
  });
  it("conserva la revisione dopo un settore aggiunto dalla sintesi", () => {
    const { p, profile } = fixture("Instandhaltung der Türen.");
    p.sectors.push("manutenzioni");
    const args = {
      publication: p,
      sectors: profile.sectors,
      activities: profile.activities,
      preliminary: preliminaryMatch(p, profile, now),
      profileRevision: "profile-v1",
      revision: `${p.revision}:profile-v1:ready:model:true:activity-review:building-activity-review-v1:hash`,
    };
    expect(args.preliminary.activityReview).toBeUndefined();
    expect(activityReviewForMatch(args)?.version).toBe(
      "building-activity-review-v1",
    );
    expect(
      activityReviewForMatch({ ...args, profileRevision: "changed" }),
    ).toBeUndefined();
  });
});
