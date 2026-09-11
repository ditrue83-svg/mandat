import { describe, expect, it } from "vitest";
import { demoProfile } from "../src/lib/demo";
import {
  profileBasicsSchema,
  profileFieldStep,
  profilePreferencesSchema,
  profileSchema,
  profileSearchSchema,
} from "../src/lib/validation";

describe("Creazione guidata della ditta", () => {
  it("convalida le basi senza richiedere le scelte dei passi successivi", () => {
    const draft = {
      ...demoProfile,
      name: "  Ditta Esempio  ",
      activities: "  Cura degli spazi verdi  ",
      sectors: [],
      zones: [],
      minValue: 200,
      maxValue: 100,
    };
    expect(profileBasicsSchema.parse(draft)).toEqual({
      name: "Ditta Esempio",
      activities: "Cura degli spazi verdi",
      employees: demoProfile.employees,
    });
    expect(profileSchema.safeParse(draft).success).toBe(false);
  });

  it.each([
    ["name", "Inserisci il nome della ditta, con almeno 2 caratteri."],
    [
      "activities",
      "Descrivi di cosa si occupa la ditta, con almeno 5 caratteri.",
    ],
  ])(
    "rifiuta spazi senza testo nel campo %s già al primo passo",
    (field, message) => {
      const result = profileBasicsSchema.safeParse({
        ...demoProfile,
        [field]: "     ",
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0]).toMatchObject({ path: [field], message });
      expect(profileFieldStep(result.error.issues[0].path[0])).toBe(1);
    },
  );

  it.each([
    ["sectors", "Seleziona almeno un settore di attività."],
    ["zones", "Seleziona almeno una zona in cui vuoi lavorare."],
  ])(
    "segnala in italiano la scelta mancante %s, anche al salvataggio finale",
    (field, message) => {
      const draft = { ...demoProfile, [field]: [] };
      for (const schema of [profileSearchSchema, profileSchema]) {
        const result = schema.safeParse(draft);
        expect(result.success).toBe(false);
        if (result.success) continue;
        expect(result.error.issues[0]).toMatchObject({
          path: [field],
          message,
        });
        expect(profileFieldStep(result.error.issues[0].path[0])).toBe(2);
      }
    },
  );

  it("accetta un settore e una zona senza dettagli facoltativi", () => {
    const draft = {
      ...demoProfile,
      sectors: ["giardinaggio"],
      zones: ["Tutto il Ticino"],
      keywords: [],
      exclusions: [],
      minValue: null,
      maxValue: null,
    };
    expect(profileSearchSchema.safeParse(draft).success).toBe(true);
    expect(profilePreferencesSchema.safeParse(draft).success).toBe(true);
    expect(profileSchema.parse(draft)).toEqual(draft);
  });

  it("conserva il controllo fra importo minimo e massimo nel passo finale e sul profilo completo", () => {
    const draft = { ...demoProfile, minValue: 1000, maxValue: 200 };
    for (const schema of [profilePreferencesSchema, profileSchema]) {
      const result = schema.safeParse(draft);
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues[0]).toMatchObject({
        path: ["maxValue"],
        message: "L’importo minimo non può superare l’importo massimo.",
      });
      expect(profileFieldStep(result.error.issues[0].path[0])).toBe(3);
    }
  });

  it.each([
    [null, 200],
    [200, null],
    [200, 200],
    [0, 200],
  ])(
    "accetta una fascia valida o con un solo limite: %s–%s",
    (minValue, maxValue) => {
      expect(
        profileSchema.safeParse({ ...demoProfile, minValue, maxValue }).success,
      ).toBe(true);
    },
  );

  it.each([
    [
      "sectors",
      ["settore-non-previsto"],
      "Scegli un settore tra quelli disponibili.",
    ],
    ["zones", ["zona-non-prevista"], "Scegli una zona tra quelle disponibili."],
  ])(
    "mantiene il controllo sui valori ammessi di %s",
    (field, value, message) => {
      const result = profileSchema.safeParse({
        ...demoProfile,
        [field]: value,
      });
      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0].message).toBe(message);
      expect(profileFieldStep(result.error.issues[0].path[0])).toBe(2);
    },
  );

  it("riporta gli errori delle parole chiave al passo dei dettagli facoltativi", () => {
    const result = profileSchema.safeParse({
      ...demoProfile,
      keywords: ["x".repeat(81)],
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]).toMatchObject({
      path: ["keywords", 0],
      message: "Ogni parola o attività può contenere al massimo 80 caratteri.",
    });
    expect(profileFieldStep(result.error.issues[0].path[0])).toBe(3);
  });
});
