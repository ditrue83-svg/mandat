import { describe, expect, it } from "vitest";
import { demoProfile, getDemoOpportunities } from "../src/lib/demo";
import type { CompanyProfile, Publication } from "../src/lib/domain";
import { findPublishedObjectReview } from "../src/lib/cpv-object-review";
import { activityReviewForMatch } from "../src/lib/cpv-service-signals";
import { preliminaryMatch } from "../src/lib/matching";

const now = new Date("2030-01-01T10:00:00Z");
function fixture() {
  const p: Publication = {
    ...getDemoOpportunities(now)[0],
    title: "Componenti di chiusura degli edifici",
    originalText: "Dettagli negli allegati.",
    originalTitles: [],
    originalDescriptions: [],
    documentPages: [],
    summary: null,
    sectors: ["edilizia"],
    cpv: ["45421100"],
    canton: "TI",
    zone: "Luganese",
    valueChf: null,
    status: "open",
    visibleAt: "2029-01-01T07:00:00Z",
    deadline: "2031-01-01T10:00:00Z",
  };
  const profile: CompanyProfile = {
    ...demoProfile,
    activities: "Ripariamo porte e serrature.",
    sectors: ["manutenzioni"],
    keywords: [],
    exclusions: [],
    zones: ["Tutto il Ticino"],
    minValue: null,
    maxValue: null,
  };
  return { p, profile };
}
describe("componenti classificati e attività da verificare", () => {
  it.each([
    "45421100",
    "45421110",
    "45421111",
    "45421130",
    "45421131",
    "45421100-5",
  ])(
    "ammette %s solo alla revisione e conserva entrambe le evidenze",
    (cpv) => {
      const { p, profile } = fixture();
      p.cpv = [cpv];
      const r = preliminaryMatch(p, profile, now);
      expect(r).toMatchObject({
        eligible: true,
        score: 0,
        uncertain: true,
        activityReview: { version: "published-building-object-review-v2" },
      });
      expect(r.activityReview!.signals[0]).toMatchObject({
        basis: "published_cpv_component",
        field: "cpv[0]",
        quote: cpv,
        profileEvidence: { field: "activities", quote: "porte" },
      });
      expect(
        findPublishedObjectReview(p, profile)?.professionalRelationEstablished,
      ).toBe(false);
    },
  );
  it("richiede il componente dichiarato e conserva il suo testo originale", () => {
    const { p, profile } = fixture();
    profile.activities = "🔧 Regoliamo PORTONI e cancelli.";
    p.cpv = ["45000000", "45421148-3"];
    const [s] = preliminaryMatch(p, profile, now).activityReview!.signals;
    expect(s).toMatchObject({
      field: "cpv[1]",
      quote: "45421148-3",
      profileEvidence: { quote: "cancelli" },
    });
    expect(
      profile.activities.slice(
        s.profileEvidence!.start,
        s.profileEvidence!.end,
      ),
    ).toBe("cancelli");
    profile.activities = "Manutenzione frigoriferi e supporti.";
    expect(preliminaryMatch(p, profile, now).eligible).toBe(false);
  });
  it.each([
    "44520000",
    "44520000-1",
    "44521000-8",
    "44521100-9",
    "44521110-2",
    "44521120-5",
    "44521130-8",
    "44522000-5",
    "44522400-9",
  ])(
    "recupera %s per un profilo che dichiara serrature, senza dedurre il ruolo",
    (cpv) => {
      const { p, profile } = fixture();
      p.cpv = [cpv];
      profile.activities = "🔑 Ripariamo SERRATURE negli edifici.";
      const r = preliminaryMatch(p, profile, now);
      expect(r).toMatchObject({ eligible: true, score: 0, uncertain: true });
      const [signal] = r.activityReview!.signals;
      expect(signal).toMatchObject({
        basis: "published_cpv_component",
        field: "cpv[0]",
        quote: cpv,
        profileEvidence: {
          field: "activities",
          quote: "SERRATURE",
          start: 13,
          end: 22,
        },
      });
      profile.activities =
        "Regoliamo porte, ma il dettaglio dei componenti non è indicato.";
      expect(preliminaryMatch(p, profile, now).eligible).toBe(false);
    },
  );
  it.each([
    "44521140-1",
    "44521200-0",
    "44522200-7",
    "44523100-3",
    "44520000-9",
    "4452",
  ])("non estende la regola serrature alla classe %s", (cpv) => {
    const { p, profile } = fixture();
    p.cpv = [cpv];
    expect(findPublishedObjectReview(p, profile)).toBeUndefined();
  });
  it("non usa composti o un altro settore del profilo come dichiarazione di serrature", () => {
    const { p, profile } = fixture();
    p.cpv = ["44520000"];
    profile.activities = "Supporto al portale preventivi_serrature.";
    expect(findPublishedObjectReview(p, profile)).toBeUndefined();
    profile.activities = "Fornitura serrature";
    profile.sectors = ["sicurezza"];
    expect(findPublishedObjectReview(p, profile)).toBeUndefined();
  });
  it.each(["45421132", "45421140", "45000000", "72200000", "45421100-9"])(
    "non attribuisce porte a %s",
    (cpv) => {
      const { p, profile } = fixture();
      p.cpv = [cpv];
      expect(preliminaryMatch(p, profile, now)).toMatchObject({
        eligible: false,
        score: 0,
      });
    },
  );
  it("mantiene i vincoli operativi prima del recupero", () => {
    for (const change of [
      { status: "awarded" },
      { deadline: "2029-01-01T10:00:00Z" },
      { visibleAt: "2031-01-01T07:00:00Z" },
      { canton: "GE" },
      { zone: "Bellinzonese" },
      { valueChf: 500 },
      { originalText: "Lavoro escluso dal profilo." },
    ]) {
      const { p, profile } = fixture();
      Object.assign(p, change);
      profile.zones = ["Luganese"];
      profile.minValue = 1000;
      profile.exclusions = ["escluso"];
      expect(preliminaryMatch(p, profile, now)).toMatchObject({
        eligible: false,
        score: 0,
      });
    }
  });
  it("conserva il segnale corrente dopo l’aggiunta di un settore da parte della sintesi", () => {
    const { p, profile } = fixture();
    p.sectors = ["edilizia", "manutenzioni"];
    const args = {
      publication: p,
      sectors: profile.sectors,
      activities: profile.activities,
      preliminary: preliminaryMatch(p, profile, now),
      revision: `${p.revision}:profile-v1:ready:model:true:activity-review:published-building-object-review-v1:hash`,
      profileRevision: "profile-v1",
    };
    expect(args.preliminary.activityReview).toBeUndefined();
    expect(activityReviewForMatch(args)?.version).toBe(
      "published-building-object-review-v2",
    );
    expect(
      activityReviewForMatch({ ...args, profileRevision: "changed" }),
    ).toBeUndefined();
  });
});
