import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings } from "luxon";
import { parseDeadline } from "../src/sources/common";
import { normalizeSimap } from "../src/sources/simap";

afterEach(() => {
  vi.useRealTimers();
  Settings.resetCaches();
});

describe("Scadenze locali svizzere durante i cambi d’ora", () => {
  it.each(["2026-01-01T12:00:00Z", "2026-07-01T12:00:00Z"])(
    "non sceglie un offset per un’ora ripetuta quando elabora il %s",
    (now) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      Settings.resetCaches();
      expect(parseDeadline("2026-10-25T02:30:00")).toBeNull();
      expect(parseDeadline("2026-10-25T02:00:00")).toBeNull();
      expect(parseDeadline("2026-10-25T02:59:59")).toBeNull();
    },
  );

  it("non sposta in avanti un orario inesistente", () => {
    expect(parseDeadline("2026-03-29T02:00:00")).toBeNull();
    expect(parseDeadline("2026-03-29T02:30:00")).toBeNull();
    expect(parseDeadline("2026-03-29T02:59:59")).toBeNull();
  });

  it.each([
    ["2026-01-15T12:00:00", "2026-01-15T11:00:00.000Z"],
    ["2026-07-15T12:00:00", "2026-07-15T10:00:00.000Z"],
    ["2026-03-29T01:59:59", "2026-03-29T00:59:59.000Z"],
    ["2026-03-29T03:00:00", "2026-03-29T01:00:00.000Z"],
    ["2026-10-25T01:59:59", "2026-10-24T23:59:59.000Z"],
    ["2026-10-25T03:00:00", "2026-10-25T02:00:00.000Z"],
  ])("conserva l’ora locale esistente e univoca %s", (value, expected) => {
    expect(parseDeadline(value)).toBe(expected);
  });

  it.each([
    ["2026-10-25T02:30:00+02:00", "2026-10-25T00:30:00.000Z"],
    ["2026-10-25T02:30:00+01:00", "2026-10-25T01:30:00.000Z"],
    ["2026-10-25T02:30:00Z", "2026-10-25T02:30:00.000Z"],
    ["2026-03-29T02:30:00+01:00", "2026-03-29T01:30:00.000Z"],
    ["2026-03-29T02:30:00+0200", "2026-03-29T00:30:00.000Z"],
    ["2026-03-29T02:30:00+02", "2026-03-29T00:30:00.000Z"],
    ["2026-07-15T12:00:00-04:00", "2026-07-15T16:00:00.000Z"],
  ])(
    "non cambia l’istante esplicitamente indicato da %s",
    (value, expected) => {
      expect(parseDeadline(value)).toBe(expected);
    },
  );

  it("tratta il nome del fuso senza offset come un orario locale da verificare", () => {
    expect(parseDeadline("2026-10-25T02:30:00[Europe/Zurich]")).toBeNull();
    expect(parseDeadline("2026-03-29T02:30:00[Europe/Zurich]")).toBeNull();
    expect(parseDeadline("2026-07-15T12:00:00[Europe/Zurich]")).toBe(
      "2026-07-15T10:00:00.000Z",
    );
  });

  it("mantiene non disponibili date sole, date impossibili e input non testuali", () => {
    for (const value of [
      "2026-10-25",
      "2026-02-30T12:00:00",
      "2026-10-25T28:00:00",
      "testo",
      null,
      123,
    ])
      expect(parseDeadline(value)).toBeNull();
  });

  it.each(["open", "selective"])(
    "mantiene il bando %s aperto ma richiede revisione della scadenza ambigua",
    (processType) => {
      const id = "11111111-1111-4111-8111-111111111111";
      const publicationId = "22222222-2222-4222-8222-222222222222";
      const publication = normalizeSimap(
        {
          id,
          raw: {
            id,
            publicationId,
            publicationDate: "2026-09-01",
            projectNumber: "TEST-DST-1",
            pubType: "tender",
            processType,
            title: { it: "Prestazione di esempio" },
            procOfficeName: { it: "Ente inventato" },
          },
        },
        {
          id: publicationId,
          type: "tender",
          dates: {
            offerDeadline: "2026-10-25T02:30:00",
            participationRequestDeadline: "2026-10-25T02:30:00",
          },
          procurement: {
            orderDescription: { it: "Prestazione interamente inventata." },
            orderAddress: { city: { it: "Lugano" }, cantonId: "TI" },
          },
        },
      );
      expect(publication.status).toBe("open");
      expect(publication.deadline).toBeNull();
      expect(publication.reviewRequired).toBe(true);
      expect(publication.reviewReasons).toContain(
        "Scadenza non disponibile o priva di orario",
      );
      expect(publication.evidence.some((e) => e.field === "Scadenza")).toBe(
        false,
      );
    },
  );
});
