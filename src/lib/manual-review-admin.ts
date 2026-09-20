import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { administrators, companies, issues, settings } from "@/db/schema";
import type { Viewer } from "./domain";
import { HttpError } from "./viewer";
import {
  lockPilotControl,
  readPilotStartedAtInTransaction,
} from "./pilot-control";
import { profileSchema } from "./validation";
import {
  MANUAL_REVIEW_WINDOW,
  readManualReviewWindow,
  reviewProfileMatches,
  manualReviewProfileRevision,
  type ManualReviewWindow,
} from "./manual-review-window";
import {
  pilotPrerequisiteKeys,
  pilotPrerequisiteSettingKey,
  readPilotPrerequisite,
} from "./pilot";

export async function startManualReview(
  viewer: Viewer,
  now = new Date(),
  expectedProfileRevision = manualReviewProfileRevision(viewer.profile),
) {
  if (viewer.demo || !viewer.admin)
    throw new HttpError(403, "Operazione riservata al fondatore.");
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid review clock");
  return getDb().transaction(async (tx) => {
    await lockPilotControl(tx);
    if (await readPilotStartedAtInTransaction(tx))
      throw new HttpError(
        409,
        "Il pilota ha già un proprio periodo di revisione.",
      );
    const [company] = await tx
      .select()
      .from(companies)
      .innerJoin(administrators, eq(administrators.userId, companies.ownerId))
      .where(
        and(
          eq(companies.id, viewer.companyId),
          eq(companies.ownerId, viewer.userId),
        ),
      )
      .for("update");
    if (
      !company ||
      company.companies.disabledAt ||
      !company.companies.onboardedAt ||
      !profileSchema.safeParse(company.companies.profile).success
    )
      throw new HttpError(400, "Completa prima il profilo della tua attività.");
    if (
      manualReviewProfileRevision(company.companies.profile) !==
      expectedProfileRevision
    )
      throw new HttpError(
        409,
        "Il profilo è cambiato. Ricarica e verifica l’attività prima di iniziare.",
      );
    const rows = await tx
      .select()
      .from(settings)
      .where(
        inArray(settings.key, [
          "automation_enabled",
          MANUAL_REVIEW_WINDOW,
          ...pilotPrerequisiteKeys.map(pilotPrerequisiteSettingKey),
        ]),
      );
    const values = new Map(rows.map((row) => [row.key, row.value]));
    if (values.get("automation_enabled") === true)
      throw new HttpError(
        409,
        "Torna alla revisione manuale prima di avviare un nuovo periodo.",
      );
    if (
      !pilotPrerequisiteKeys.every(
        (key) =>
          readPilotPrerequisite(
            key,
            values.get(pilotPrerequisiteSettingKey(key)),
          )?.confirmed,
      )
    )
      throw new HttpError(
        400,
        "Completa le verifiche sulla residenza dei dati e sul recapito email esterno.",
      );
    const critical = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.severity, "critical"), isNull(issues.resolvedAt)))
      .limit(1);
    if (critical.length)
      throw new HttpError(
        400,
        "Risolvi i problemi critici aperti prima di iniziare.",
      );
    const prior = readManualReviewWindow(values.get(MANUAL_REVIEW_WINDOW));
    if (prior && prior.companyId !== viewer.companyId)
      throw new HttpError(
        409,
        "Esiste già una revisione per un altro profilo del fondatore.",
      );
    if (prior && reviewProfileMatches(prior, company.companies))
      throw new HttpError(
        409,
        "La revisione per questo profilo è già iniziata.",
      );
    const window: ManualReviewWindow = {
      version: "manual-review-window-v1",
      id: crypto.randomUUID(),
      companyId: viewer.companyId,
      actorId: viewer.userId,
      startedAt: now.toISOString(),
      profileRevision: manualReviewProfileRevision(company.companies.profile),
      realActivityConfirmed: true,
    };
    // The previous period remains available; restarting never rewrites its dates.
    await tx
      .insert(settings)
      .values({ key: `${MANUAL_REVIEW_WINDOW}:${window.id}`, value: window });
    await tx
      .insert(settings)
      .values({ key: MANUAL_REVIEW_WINDOW, value: window })
      .onConflictDoUpdate({ target: settings.key, set: { value: window } });
    return window;
  });
}
