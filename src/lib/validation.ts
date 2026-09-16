import { z } from "zod";
import { SECTORS, ZONES } from "./domain";
export const profileBasicsSchema = z.object({
  name: z
    .string({ error: "Inserisci il nome della ditta." })
    .trim()
    .min(2, "Inserisci il nome della ditta, con almeno 2 caratteri.")
    .max(150, "Il nome della ditta può contenere al massimo 150 caratteri."),
  activities: z
    .string({ error: "Descrivi di cosa si occupa la ditta." })
    .trim()
    .min(5, "Descrivi di cosa si occupa la ditta, con almeno 5 caratteri.")
    .max(2000, "La descrizione può contenere al massimo 2000 caratteri."),
  employees: z
    .number({ error: "Seleziona quante persone lavorano nella ditta." })
    .int("Il numero di persone deve essere un numero intero.")
    .min(1, "Seleziona almeno una persona.")
    .max(15, "La beta è dedicata alle ditte con al massimo 15 persone."),
});

export const profileSearchSchema = z.object({
  sectors: z
    .array(
      z.enum(
        SECTORS.map((s) => s.id),
        {
          error: "Scegli un settore tra quelli disponibili.",
        },
      ),
      { error: "Seleziona almeno un settore di attività." },
    )
    .min(1, "Seleziona almeno un settore di attività.")
    .max(8, "Puoi selezionare al massimo 8 settori di attività."),
  zones: z
    .array(
      z.enum(ZONES as [string, ...string[]], {
        error: "Scegli una zona tra quelle disponibili.",
      }),
      { error: "Seleziona almeno una zona in cui vuoi lavorare." },
    )
    .min(1, "Seleziona almeno una zona in cui vuoi lavorare.")
    .max(9, "Puoi selezionare al massimo 9 zone."),
});

const valueSchema = z
  .number({ error: "Inserisci un importo valido in CHF." })
  .min(0, "L’importo non può essere negativo.")
  .max(100000000, "L’importo può arrivare al massimo a 100 milioni di CHF.")
  .nullable();
const preferencesShape = {
  keywords: z
    .array(
      z
        .string({ error: "Inserisci una parola o un’attività da cercare." })
        .trim()
        .min(1, "Le parole e le attività da cercare non possono essere vuote.")
        .max(
          80,
          "Ogni parola o attività può contenere al massimo 80 caratteri.",
        ),
      { error: "Controlla le parole e le attività da cercare." },
    )
    .max(20, "Puoi indicare al massimo 20 parole o attività da cercare."),
  exclusions: z
    .array(
      z
        .string({ error: "Inserisci un lavoro da escludere." })
        .trim()
        .min(1, "I lavori da escludere non possono essere vuoti.")
        .max(
          80,
          "Ogni lavoro da escludere può contenere al massimo 80 caratteri.",
        ),
      { error: "Controlla i lavori da escludere." },
    )
    .max(20, "Puoi indicare al massimo 20 lavori da escludere."),
  minValue: valueSchema,
  maxValue: valueSchema,
  emailEnabled: z.boolean({ error: "Scegli se ricevere il riepilogo email." }),
};
const validValueRange = (p: {
  minValue: number | null;
  maxValue: number | null;
}) => p.minValue === null || p.maxValue === null || p.minValue <= p.maxValue;
const valueRangeError = {
  message: "L’importo minimo non può superare l’importo massimo.",
  path: ["maxValue"],
};

export const profilePreferencesSchema = z
  .object(preferencesShape)
  .refine(validValueRange, valueRangeError);

export const profileSchema = z
  .object({
    ...profileBasicsSchema.shape,
    ...profileSearchSchema.shape,
    ...preferencesShape,
  })
  .refine(validValueRange, valueRangeError);

export function profileFieldStep(field: PropertyKey | undefined): 1 | 2 | 3 {
  if (field === "name" || field === "activities" || field === "employees")
    return 1;
  if (field === "sectors" || field === "zones") return 2;
  return 3;
}
export const feedbackSchema = z
  .object({
    saved: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    relevant: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const catalogBookmarkSchema = z.object({ saved: z.boolean() }).strict();
export const inviteSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase().trim()),
  name: z.string().trim().min(2).max(150),
});
