import { describe, expect, it } from "vitest";
import casesJson from "./fixtures/cpv-activity-cases.json";
import { getDemoOpportunities, demoProfile } from "../src/lib/demo";
import type { CompanyProfile, Publication } from "../src/lib/domain";
import { preliminaryMatch } from "../src/lib/matching";
import { classifySectors } from "../src/sources/common";
import {
  activityReviewForMatch,
  activityReviewBlocksAutomatic,
  findCpvServiceSignals,
} from "../src/lib/cpv-service-signals";
import { presentMatch } from "../src/lib/match-presentation";
import { classificationReviewSuffix } from "../src/lib/sector-classification";

const cases = casesJson as unknown as Array<Record<string, any>>;
const now = new Date("2026-09-13T12:00:00Z");
function fixture(c: Record<string, any>): {
  p: Publication;
  profile: CompanyProfile;
} {
  if (c.copySyntheticCase) {
    const { p, profile } = fixture(
      cases.find((x) => x.id === c.copySyntheticCase)!,
    );
    const changes = { ...c.explicitFixtureChanges };
    if (changes.profileExclusions) {
      profile.exclusions = changes.profileExclusions;
      delete changes.profileExclusions;
    }
    if (changes.profileMaxValue !== undefined) {
      profile.maxValue = changes.profileMaxValue;
      delete changes.profileMaxValue;
    }
    if (changes.descriptionSuffix) {
      p.originalText += changes.descriptionSuffix;
      delete changes.descriptionSuffix;
    }
    Object.assign(p, changes);
    return { p, profile };
  }
  const url = `https://example.invalid/cpv-synthetic/${c.id}`;
  const title = c.title ?? "Prestazioni secondo capitolato";
  const description =
    c.selectedDescription ?? "Prestazioni indicate negli allegati.";
  const cpv =
    c.sourceCpv ?? (c.mainCpv ? [c.mainCpv, ...c.additionalCpvCodes] : []);
  return {
    p: {
      ...getDemoOpportunities(now)[0],
      id: c.id,
      title,
      buyer: c.channel === "buyer" ? c.text : "Ente inventato",
      originalText: `${title}\n${description}`,
      summary: null,
      sourceUrl: url,
      sourceUrls: [url],
      originalTitles: [],
      originalDescriptions: (
        c.originalDescriptions ??
        (c.channel === "originalDescription"
          ? [{ text: c.text, language: null }]
          : [])
      ).map((d: any) => ({ ...d, url })),
      sourceConditions: [],
      documentPages: [],
      documents: [],
      evidence: [],
      requirements: [],
      reviewRequired: false,
      reviewReasons: [],
      cpv,
      sectors: classifySectors(`${title} ${description}`, cpv),
      canton: "TI",
      zone: "Luganese",
      valueChf: null,
      visibleAt: "2026-09-10T06:00:00Z",
      deadline: "2026-10-31T12:00:00Z",
      status: "open",
    },
    profile: {
      ...demoProfile,
      name: "Ditta inventata",
      activities: "Attività sintetiche per controllo del filtro",
      zones: ["Tutto il Ticino"],
      minValue: null,
      maxValue: null,
      emailEnabled: false,
      ...c.inventedProfile,
    },
  };
}

describe("recupero di attività citate nelle fonti originali", () => {
  for (const c of cases)
    it(c.id, () => {
      const { p, profile } = fixture(c);
      const signals = findCpvServiceSignals(p, profile.sectors);
      const result = preliminaryMatch(p, profile, now);
      const expectedHit =
        c.expectedSupplementalLiteralHit ??
        c.expectedSupplementalLiteralHitForTargetSector ??
        c.expectedSupplementalSignal;
      if (expectedHit !== undefined) expect(!!signals.length).toBe(expectedHit);
      if (c.expectedMaximumEffect === "manual_review_score_zero")
        expect(result).toMatchObject({
          eligible: true,
          score: 0,
          uncertain: true,
          activityReview: { signals },
        });
      if (c.expectedMaximumEffect === "no_new_recovery_from_this_feature")
        expect(result.activityReview).toBeUndefined();
      if (c.expectedMaximumEffect === "existing_path_unchanged")
        expect(result.activityReview).toBeUndefined();
      if (c.expectedExistingCpvSectorMatch !== undefined)
        expect(p.sectors.some((s) => profile.sectors.includes(s))).toBe(
          c.expectedExistingCpvSectorMatch,
        );
      if (c.expectedFullResult === "ineligible")
        expect(result.eligible).toBe(false);
    });

  it("mantiene citazione, lingua dichiarata e pagina; ignora sintesi e nomi di documenti", () => {
    const { p, profile } = fixture(cases[0]);
    p.originalDescriptions = [];
    p.summary = "Services de nettoyage de bâtiments";
    p.documents = [
      {
        title: "Services de nettoyage de bâtiments",
        url: p.sourceUrl,
        requiresLogin: true,
      },
    ];
    expect(findCpvServiceSignals(p, profile.sectors)).toEqual([]);
    p.documentPages = [
      {
        text: "🧹 Services de nettoyage de bâtiments.",
        url: `${p.sourceUrl}.pdf`,
        page: 4,
      },
    ];
    const [signal] = findCpvServiceSignals(p, profile.sectors);
    expect(signal).toMatchObject({
      quote: "Services de nettoyage de bâtiments",
      page: 4,
      language: null,
      lexiconLanguage: "fr",
      start: 3,
      end: 37,
    });
    expect(p.documentPages[0].text.slice(signal.start, signal.end)).toBe(
      signal.quote,
    );
    p.originalDescriptions = [
      {
        text: "Services de nettoyage de bâtiments.",
        url: p.sourceUrl,
        language: "fr",
      },
    ];
    expect(findCpvServiceSignals(p, profile.sectors)[0].language).toBe("fr");
  });

  it("non trasforma sottostringhe di composti o frasi separate in una prestazione", () => {
    const { p, profile } = fixture(cases[0]);
    profile.sectors = ["impianti"];
    p.originalDescriptions = [
      { text: "VorBlitzschutzarbeitenX", url: p.sourceUrl, language: "de" },
    ];
    expect(findCpvServiceSignals(p, profile.sectors)).toEqual([]);
    p.originalDescriptions = [
      {
        text: "Installation. Of lightning conductors.",
        url: p.sourceUrl,
        language: "en",
      },
    ];
    expect(findCpvServiceSignals(p, profile.sectors)).toEqual([]);
  });

  it("non consente ai settori aggiunti dalla sintesi di promuovere una revisione già registrata", () => {
    const { p, profile } = fixture(cases[0]);
    p.sectors = ["pulizie"];
    const preliminary = preliminaryMatch(p, profile, now);
    expect(preliminary.activityReview).toBeUndefined();
    const binding = {
      publication: p,
      sectors: profile.sectors,
      preliminary,
      profileRevision: "profile-v1",
      revision: `${p.revision}:profile-v1:ready:model:true:activity-review:cpv-labels-v1:signal-hash`,
    };
    expect(activityReviewForMatch(binding)?.signals.length).toBeGreaterThan(0);
    expect(
      activityReviewForMatch({ ...binding, profileRevision: "other-profile" }),
    ).toBeUndefined();
  });

  it("mostra la revisione anche senza sintesi e blocca il vecchio punteggio prima dell'email", () => {
    const { p, profile } = fixture(cases[0]);
    const preliminary = preliminaryMatch(p, profile, now);
    const match = {
      revision: `${p.revision}:profile-v1:ready:model:true`,
      reason: "Vecchio voto",
      eligible: true,
      score: 95,
      approved: null,
      reviewedAt: null,
      reviewNotes: null,
    };
    expect(
      presentMatch({
        publication: p,
        match,
        profileRevision: "profile-v1",
        aiRevision: null,
        preliminary,
      }),
    ).toMatchObject({
      assessment: "uncertain",
      score: 0,
      reason: preliminary.reason,
    });
    expect(
      activityReviewBlocksAutomatic(match, preliminary, {
        publication: p,
        profileRevision: "profile-v1",
      }),
    ).toBe(true);
    const oldManual = { ...match, approved: true, reviewedAt: now };
    expect(
      presentMatch({
        publication: p,
        match: oldManual,
        profileRevision: "profile-v1",
        aiRevision: null,
        preliminary,
      }).assessment,
    ).toBe("uncertain");
    const manual = {
      ...oldManual,
      revision: match.revision + classificationReviewSuffix(p),
    };
    expect(
      presentMatch({
        publication: p,
        match: manual,
        profileRevision: "profile-v1",
        aiRevision: null,
        preliminary,
      }).assessment,
    ).toBe("reviewed");
    expect(
      activityReviewBlocksAutomatic(manual, preliminary, {
        publication: p,
        profileRevision: "profile-v1",
      }),
    ).toBe(false);
    expect(
      presentMatch({
        publication: p,
        match: { ...manual, approved: false },
        profileRevision: "profile-v1",
        aiRevision: null,
        preliminary,
      }).assessment,
    ).toBe("rejected");
  });
});
