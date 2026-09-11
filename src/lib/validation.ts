import { z } from "zod";
import { SECTORS, ZONES } from "./domain";
export const profileSchema = z
  .object({
    name: z.string().trim().min(2).max(150),
    activities: z.string().trim().min(5).max(2000),
    employees: z.number().int().min(1).max(15),
    sectors: z
      .array(z.enum(SECTORS.map((s) => s.id)))
      .min(1)
      .max(8),
    zones: z
      .array(z.enum(ZONES as [string, ...string[]]))
      .min(1)
      .max(9),
    keywords: z.array(z.string().trim().min(1).max(80)).max(20),
    exclusions: z.array(z.string().trim().min(1).max(80)).max(20),
    minValue: z.number().min(0).max(100000000).nullable(),
    maxValue: z.number().min(0).max(100000000).nullable(),
    emailEnabled: z.boolean(),
  })
  .refine(
    (p) =>
      p.minValue === null || p.maxValue === null || p.minValue <= p.maxValue,
    {
      message: "L’importo minimo deve essere inferiore al massimo.",
      path: ["maxValue"],
    },
  );
export const feedbackSchema = z
  .object({
    saved: z.boolean().optional(),
    dismissed: z.boolean().optional(),
    relevant: z.boolean().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export const inviteSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((v) => v.toLowerCase().trim()),
  name: z.string().trim().min(2).max(150),
});
