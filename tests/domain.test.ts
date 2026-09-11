import { describe, it, expect } from "vitest";
import { getDemoOpportunities, demoProfile } from "../src/lib/demo";
import {
  preliminaryMatch,
  automationGate,
  materialChange,
  digestDue,
  zurichDigestDay,
  possibleDuplicate,
} from "../src/lib/matching";
import { normalizeSimap } from "../src/sources/simap";
import { normalizeFoglio, parseFoglioList } from "../src/sources/foglio";
import {
  publicationDate,
  parseDeadline,
  safeOfficialUrl,
} from "../src/sources/common";
import { invitationAllowsLogin } from "../src/lib/auth";
import { deliveryFailureKind } from "../src/worker/notifications";
import { validateSummary } from "../src/worker/ai";
const now = new Date("2026-09-10T08:00:00Z");
const p = getDemoOpportunities(now)[0];
describe("Pertinenza e responsabilità", () => {
  it("segnala somiglianze senza fondere progetti diversi", () => {
    expect(
      possibleDuplicate(
        { ...p, source: "simap" },
        { ...p, id: "foglio-copy", source: "foglio-ti" },
      ),
    ).toBe(true);
    expect(
      possibleDuplicate(
        { ...p, canonicalKey: "simap:1" },
        { ...p, source: "foglio-ti", canonicalKey: "simap:2" },
      ),
    ).toBe(false);
  });
  it("esclude aggiudicazioni, scaduti, cantone errato e attività escluse", () => {
    for (const changed of [
      { status: "awarded" as const },
      { deadline: "2026-01-01T12:00:00Z" },
      { canton: "ZH" },
    ])
      expect(
        preliminaryMatch({ ...p, ...changed }, demoProfile, now).eligible,
      ).toBe(false);
    expect(
      preliminaryMatch(p, { ...demoProfile, exclusions: ["parchi"] }, now)
        .eligible,
    ).toBe(false);
  });
  it("non scarta valori mancanti e richiede controllo di un luogo sconosciuto", () => {
    expect(
      preliminaryMatch(
        { ...p, valueChf: null },
        { ...demoProfile, maxValue: 100 },
        now,
      ).eligible,
    ).toBe(true);
    expect(
      preliminaryMatch(
        { ...p, zone: null },
        { ...demoProfile, zones: ["Luganese"] },
        now,
      ).uncertain,
    ).toBe(true);
  });
  it("blocca automatizzazione prima di sette giorni o con poco feedback", () => {
    const input = {
      reviewed: 20,
      approved: 16,
      criticalIssues: 0,
      startedAt: new Date("2026-09-01"),
      now,
    };
    expect(automationGate(input).allowed).toBe(true);
    expect(automationGate({ ...input, approved: 15 }).allowed).toBe(false);
    expect(automationGate({ ...input, reviewed: 19 }).allowed).toBe(false);
    expect(automationGate({ ...input, criticalIssues: 1 }).allowed).toBe(false);
    expect(automationGate({ ...input, startedAt: now }).allowed).toBe(false);
  });
  it("riconosce rettifiche di scadenza e annullamenti", () => {
    expect(materialChange(p, { ...p, deadline: "2026-09-11T12:00:00Z" })).toBe(
      true,
    );
    expect(materialChange(p, { ...p, status: "cancelled" })).toBe(true);
    expect(materialChange(p, { ...p })).toBe(false);
  });
});
describe("Orari svizzeri", () => {
  it("embargo alle 08:00 anche al cambio di ora", () => {
    expect(publicationDate("2026-09-10", 8)).toBe("2026-09-10T06:00:00.000Z");
    expect(publicationDate("2026-12-10", 8)).toBe("2026-12-10T07:00:00.000Z");
    expect(
      preliminaryMatch(
        { ...p, visibleAt: publicationDate("2026-09-10", 8) },
        demoProfile,
        new Date("2026-09-10T05:59:59Z"),
      ).eligible,
    ).toBe(false);
  });
  it("riepilogo dopo le 09 locali, non UTC", () => {
    expect(digestDue(new Date("2026-09-10T06:59:00Z"))).toBe(false);
    expect(digestDue(new Date("2026-09-10T07:00:00Z"))).toBe(true);
    expect(digestDue(new Date("2026-12-10T07:59:00Z"))).toBe(false);
    expect(zurichDigestDay(new Date("2026-09-10T22:30:00Z"))).toBe(
      "2026-09-11",
    );
  });
  it("non inventa l’orario per una data sola", () =>
    expect(parseDeadline("2026-10-10")).toBeNull());
});
describe("Inviti e consegna", () => {
  it("nega inviti scaduti/revocati e ditte disabilitate", () => {
    const i = {
      acceptedAt: null,
      revokedAt: null,
      expiresAt: new Date("2026-10-10"),
    };
    expect(invitationAllowsLogin(i, null, now)).toBe(true);
    expect(
      invitationAllowsLogin(
        { ...i, expiresAt: new Date("2025-01-01") },
        null,
        now,
      ),
    ).toBe(false);
    expect(invitationAllowsLogin({ ...i, revokedAt: now }, null, now)).toBe(
      false,
    );
    expect(invitationAllowsLogin(i, now, now)).toBe(false);
    expect(
      invitationAllowsLogin(
        { ...i, acceptedAt: now, expiresAt: new Date("2025-01-01") },
        null,
        now,
      ),
    ).toBe(true);
  });
  it("non ritenta alla cieca SMTP con esito incerto", () => {
    expect(deliveryFailureKind({ code: "ETIMEDOUT", command: "DATA" })).toBe(
      "uncertain",
    );
    expect(deliveryFailureKind({ code: "EDNS" })).toBe("failed");
    expect(deliveryFailureKind({ responseCode: 550 })).toBe("failed");
  });
  it("impedisce URL interni o con credenziali nei documenti", () => {
    expect(() =>
      safeOfficialUrl("http://127.0.0.1/", ["amtsblattportal.ch"]),
    ).toThrow();
    expect(() =>
      safeOfficialUrl("https://user:pass@amtsblattportal.ch/", [
        "amtsblattportal.ch",
      ]),
    ).toThrow();
  });
});
describe("Mapping fonti verificate", () => {
  it("usa la scadenza di presentazione, non esecuzione, su simap", () => {
    const id = "ce0bd050-c16a-42db-962a-d34814de26b7";
    const pubId = "d52f1800-da6a-4570-a650-c864370a128a";
    const entry = {
      id,
      raw: {
        id,
        publicationId: pubId,
        publicationDate: "2026-09-10",
        projectNumber: "123",
        pubType: "tender",
        processType: "open",
        title: { it: "Pulizie scuola" },
        procOfficeName: { it: "Ente esempio" },
      },
    };
    const out = normalizeSimap(entry, {
      id: pubId,
      type: "tender",
      dates: { offerDeadline: "2026-10-21T10:00:00+02:00" },
      procurement: {
        orderDescription: { it: "Pulizia di aule" },
        orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
        executionPeriod: { dateRange: ["2027-01-01", "2029-01-01"] },
      },
    });
    expect(out.deadline).toBe("2026-10-21T08:00:00.000Z");
    expect(out.canonicalKey).toBe("simap:123");
    expect(out.valueChf).toBeNull();
  });
  it("non interpreta expirationDate come scadenza gara", () => {
    const result = normalizeFoglio(
      `<publication><meta><id>274fc2e7-5586-459b-b3a1-7bc2f79a8721</id><publicationNumber>OB-TI10-1</publicationNumber><subRubric>OB-TI10</subRubric><publicationDate>2026-09-10</publicationDate><publicationState>PUBLISHED</publicationState><expirationDate>2031-09-10</expirationDate><title><it>Bando - Pulizie</it></title></meta><content><publication>Pulizie scuola.</publication><simapPublicationNumber>#123-01</simapPublicationNumber></content></publication>`,
    );
    expect(result.deadline).toBeNull();
    expect(result.reviewRequired).toBe(true);
    expect(result.canonicalKey).toBe("simap:123");
  });
  it("rifiuta uno schema XML sconosciuto", () =>
    expect(() => parseFoglioList("<html>Errore</html>")).toThrow());
  it("rifiuta citazioni inventate dall’AI", () =>
    expect(() =>
      validateSummary(
        {
          summary: "Questo riassunto presenta informazioni inventate.",
          requirements: [],
          sectors: ["pulizie"],
          evidence: [{ field: "oggetto", quote: "una frase mai presente" }],
        },
        p,
      ),
    ).toThrow("Citazione"));
});
