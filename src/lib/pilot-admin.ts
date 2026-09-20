import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import {
  administrators,
  companies,
  invitations,
  issues,
  matches,
  notifications,
  pilotAudits,
  pilotContinuation,
  pilotParticipants,
  publications,
  settings,
} from "@/db/schema";
import { HttpError } from "./viewer";
import {
  createPilotPrerequisite,
  PILOT_COMPANY_TARGET,
  PILOT_DURATION_DAYS,
  pilotPrerequisiteKeys,
  pilotPrerequisiteSettingKey,
  pilotOperationalStartBlockers,
  readPilotPrerequisite,
  type PilotPrerequisiteKey,
} from "./pilot";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "./pilot-participation";
import {
  lockPilotControl,
  readPilotStartedAtInTransaction,
} from "./pilot-control";

export function pilotDate(value: unknown) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

export async function readPilotStartedAt() {
  const [row] = await getDb()
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "pilot_started_at"));
  return pilotDate(row?.value);
}

export async function readPilotPrerequisites() {
  const rows = await getDb()
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(
      inArray(
        settings.key,
        pilotPrerequisiteKeys.map(pilotPrerequisiteSettingKey),
      ),
    );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return Object.fromEntries(
    pilotPrerequisiteKeys.map((key) => [
      key,
      readPilotPrerequisite(key, values.get(pilotPrerequisiteSettingKey(key))),
    ]),
  ) as Record<PilotPrerequisiteKey, ReturnType<typeof readPilotPrerequisite>>;
}

export async function setPilotPrerequisite(input: {
  key: PilotPrerequisiteKey;
  confirmed: boolean;
  note: string;
  actorId: string;
  now?: Date;
}) {
  const value = createPilotPrerequisite(
    input.key,
    input.confirmed,
    input.note,
    input.actorId,
    input.now,
  );
  await getDb().transaction(async (tx) => {
    await lockPilotControl(tx);
    if (await readPilotStartedAtInTransaction(tx))
      throw new HttpError(
        409,
        "Le verifiche iniziali restano fissate dopo l’avvio del pilota.",
      );
    await tx
      .insert(settings)
      .values({ key: pilotPrerequisiteSettingKey(input.key), value })
      .onConflictDoUpdate({
        target: settings.key,
        set: { value },
      });
  });
  return value;
}

export async function startPilot(now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid pilot clock");
  const db = getDb();
  return db.transaction(async (tx) => {
    await lockPilotControl(tx);
    const existing = await readPilotStartedAtInTransaction(tx);
    if (existing)
      throw new HttpError(
        409,
        `Il pilota è già iniziato il ${existing.toISOString()}.`,
      );
    const prerequisiteRows = await tx
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(
        inArray(
          settings.key,
          pilotPrerequisiteKeys.map(pilotPrerequisiteSettingKey),
        ),
      );
    const prerequisiteValues = new Map(
      prerequisiteRows.map((row) => [row.key, row.value]),
    );
    const prerequisites = Object.fromEntries(
      pilotPrerequisiteKeys.map((key) => [
        key,
        readPilotPrerequisite(
          key,
          prerequisiteValues.get(pilotPrerequisiteSettingKey(key)),
        ),
      ]),
    ) as Record<PilotPrerequisiteKey, ReturnType<typeof readPilotPrerequisite>>;
    if (!pilotPrerequisiteKeys.every((key) => prerequisites[key]?.confirmed))
      throw new HttpError(
        400,
        "Completa prima le verifiche sulla residenza dei dati e sul recapito email esterno.",
      );
    const participants = await tx
      .select({
        companyId: companies.id,
        invitationId: invitations.id,
        acceptedAt: invitations.acceptedAt,
        acceptedVersion: invitations.acceptedVersion,
        onboardedAt: companies.onboardedAt,
        adminId: administrators.userId,
      })
      .from(invitations)
      .innerJoin(companies, eq(companies.id, invitations.companyId))
      .leftJoin(administrators, eq(administrators.userId, companies.ownerId))
      .where(and(isNull(invitations.revokedAt), isNull(companies.disabledAt)));
    const firms = participants.filter((participant) => !participant.adminId);
    if (firms.length !== PILOT_COMPANY_TARGET)
      throw new HttpError(
        400,
        `Servono esattamente ${PILOT_COMPANY_TARGET} ditte pilota attive.`,
      );
    if (
      firms.some(
        (firm) =>
          !firm.acceptedAt ||
          firm.acceptedVersion !== PILOT_PARTICIPATION_TERMS_VERSION ||
          !firm.onboardedAt,
      )
    )
      throw new HttpError(
        400,
        "Tutte le cinque ditte devono aver accettato l’informativa corrente e completato il profilo.",
      );
    const criticalIssues = await tx
      .select({ id: issues.id })
      .from(issues)
      .where(and(eq(issues.severity, "critical"), isNull(issues.resolvedAt)))
      .limit(1);
    const [automation] = await tx
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, "automation_enabled"));
    const operationalBlockers = pilotOperationalStartBlockers({
      criticalIssues: criticalIssues.length,
      automationEnabled: automation?.value === true,
    });
    if (operationalBlockers.length)
      throw new HttpError(400, operationalBlockers.join(" "));
    const startedAt = now.toISOString();
    const inserted = await tx
      .insert(settings)
      .values({ key: "pilot_started_at", value: startedAt })
      .onConflictDoNothing()
      .returning({ value: settings.value });
    if (!inserted.length)
      throw new HttpError(409, "Il pilota è già stato avviato.");
    await tx.insert(pilotParticipants).values(
      firms.map((firm) => ({
        companyId: firm.companyId,
        invitationId: firm.invitationId,
        startedAt: now,
      })),
    );
    return {
      startedAt,
      endsAt: new Date(
        now.getTime() + PILOT_DURATION_DAYS * 86_400_000,
      ).toISOString(),
    };
  });
}

async function activePilotMatch(matchId: string) {
  const [row] = await getDb()
    .select({
      matchId: matches.id,
      companyId: companies.id,
      publicationId: publications.id,
      canonicalId: publications.canonicalId,
      acceptedAt: invitations.acceptedAt,
      onboardedAt: companies.onboardedAt,
      revokedAt: invitations.revokedAt,
      disabledAt: companies.disabledAt,
      adminId: administrators.userId,
      pilotStartedAt: pilotParticipants.startedAt,
    })
    .from(matches)
    .innerJoin(companies, eq(companies.id, matches.companyId))
    .innerJoin(invitations, eq(invitations.companyId, companies.id))
    .innerJoin(publications, eq(publications.id, matches.publicationId))
    .innerJoin(pilotParticipants, eq(pilotParticipants.companyId, companies.id))
    .leftJoin(administrators, eq(administrators.userId, companies.ownerId))
    .where(eq(matches.id, matchId));
  if (
    !row ||
    row.adminId ||
    !row.pilotStartedAt ||
    row.revokedAt ||
    row.disabledAt ||
    !row.acceptedAt ||
    !row.onboardedAt
  )
    throw new HttpError(
      400,
      "La valutazione non appartiene a una ditta pilota attiva.",
    );
  return row;
}

export async function recordPilotAudit(input: {
  matchId: string;
  relevant: boolean;
  note: string;
  reviewerId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const startedAt = await readPilotStartedAt();
  if (!startedAt)
    throw new HttpError(
      400,
      "Avvia il pilota prima di registrare il campione.",
    );
  const endsAt = new Date(
    startedAt.getTime() + PILOT_DURATION_DAYS * 86_400_000,
  );
  if (now < startedAt || now >= endsAt)
    throw new HttpError(
      400,
      "Il campione di copertura va registrato durante le quattro settimane del pilota.",
    );
  const match = await activePilotMatch(input.matchId);
  const members = await getDb()
    .select({ id: publications.id })
    .from(publications)
    .where(eq(publications.canonicalId, match.canonicalId));
  const memberIds = new Set(members.map((member) => member.id));
  const delivered = await getDb()
    .select({ sentAt: notifications.sentAt, items: notifications.items })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, match.companyId),
        eq(notifications.status, "sent"),
        inArray(notifications.kind, ["digest", "lot-update"]),
        isNotNull(notifications.sentAt),
      ),
    );
  const alertedAt = delivered
    .filter(
      (notification) =>
        notification.sentAt &&
        notification.sentAt <= now &&
        notification.items.some((item) => memberIds.has(item.id)),
    )
    .map((notification) => notification.sentAt!)
    .sort((a, b) => a.getTime() - b.getTime())[0];
  const values = {
    id: crypto.randomUUID(),
    companyId: match.companyId,
    publicationId: match.publicationId,
    canonicalId: match.canonicalId,
    relevant: input.relevant,
    alertedAt: alertedAt ?? null,
    reviewerId: input.reviewerId,
    note: input.note,
    auditedAt: now,
    updatedAt: now,
  };
  await getDb()
    .insert(pilotAudits)
    .values(values)
    .onConflictDoUpdate({
      target: [pilotAudits.companyId, pilotAudits.canonicalId],
      set: {
        relevant: values.relevant,
        reviewerId: values.reviewerId,
        note: values.note,
        updatedAt: values.updatedAt,
      },
    });
  return { alertedAt: alertedAt?.toISOString() ?? null };
}

export async function recordPilotContinuation(input: {
  companyId: string;
  interested: boolean;
  note: string;
  reviewerId: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const startedAt = await readPilotStartedAt();
  if (!startedAt)
    throw new HttpError(
      400,
      "Avvia il pilota prima di registrare la risposta finale.",
    );
  if (now.getTime() < startedAt.getTime() + PILOT_DURATION_DAYS * 86_400_000)
    throw new HttpError(
      400,
      "Raccogli la risposta sull’interesse a continuare al termine delle quattro settimane.",
    );
  const [participant] = await getDb()
    .select({
      companyId: companies.id,
      adminId: administrators.userId,
      pilotStartedAt: pilotParticipants.startedAt,
    })
    .from(companies)
    .innerJoin(invitations, eq(invitations.companyId, companies.id))
    .innerJoin(pilotParticipants, eq(pilotParticipants.companyId, companies.id))
    .leftJoin(administrators, eq(administrators.userId, companies.ownerId))
    .where(eq(companies.id, input.companyId));
  if (!participant || participant.adminId || !participant.pilotStartedAt)
    throw new HttpError(400, "Ditta pilota non disponibile.");
  await getDb()
    .insert(pilotContinuation)
    .values({
      companyId: input.companyId,
      interested: input.interested,
      reviewerId: input.reviewerId,
      note: input.note,
      recordedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: pilotContinuation.companyId,
      set: {
        interested: input.interested,
        reviewerId: input.reviewerId,
        note: input.note,
        updatedAt: now,
      },
    });
}
