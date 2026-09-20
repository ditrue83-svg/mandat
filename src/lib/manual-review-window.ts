import { z } from "zod";
import type { CompanyProfile } from "./domain";
import { fingerprint } from "@/sources/common";

export const MANUAL_REVIEW_WINDOW = "manual_review_window";
const schema = z
  .object({
    version: z.literal("manual-review-window-v1"),
    id: z.uuid(),
    companyId: z.string().min(1),
    actorId: z.string().min(1),
    startedAt: z.iso.datetime({ offset: true }),
    profileRevision: z.string().regex(/^[a-f0-9]{64}$/),
    realActivityConfirmed: z.literal(true),
  })
  .strict();
export type ManualReviewWindow = z.infer<typeof schema>;
export function manualReviewProfileRevision(profile: CompanyProfile) {
  return fingerprint(
    Object.fromEntries(
      Object.entries(profile).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
export function readManualReviewWindow(value: unknown) {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}
export function reviewProfileMatches(
  window: ManualReviewWindow,
  company: { id: string; profile: CompanyProfile },
) {
  return (
    window.companyId === company.id &&
    window.profileRevision === manualReviewProfileRevision(company.profile)
  );
}
// A founder's independent qualification never enables other companies.
// Existing pilot operation retains its original scope and review safeguards.
export function automationForCompany(
  configuration: ReadonlyMap<string, unknown>,
  company: { id: string; profile: CompanyProfile },
  now = new Date(),
) {
  if (configuration.get("automation_enabled") !== true) return false;
  const pilotStart = configuration.get("pilot_started_at");
  if (pilotStart !== undefined)
    return (
      typeof pilotStart === "string" &&
      Number.isFinite(new Date(pilotStart).getTime()) &&
      new Date(pilotStart) <= now
    );
  if (!configuration.has(MANUAL_REVIEW_WINDOW)) return true;
  const window = readManualReviewWindow(
    configuration.get(MANUAL_REVIEW_WINDOW),
  );
  return (
    !!window &&
    reviewProfileMatches(window, company) &&
    now.getTime() - new Date(window.startedAt).getTime() >= 7 * 86400000
  );
}
