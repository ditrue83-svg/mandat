import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "@/db";
import { administrators, companies, invitations } from "@/db/schema";
import { HttpError } from "./viewer";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "./pilot-participation";

export { PILOT_PARTICIPATION_TERMS_VERSION } from "./pilot-participation";

export async function acceptPilotParticipation(input: {
  userId: string;
  termsVersion: typeof PILOT_PARTICIPATION_TERMS_VERSION;
  participationConfirmed: true;
  emailProcessingConfirmed: true;
  now?: Date;
}) {
  if (
    input.termsVersion !== PILOT_PARTICIPATION_TERMS_VERSION ||
    input.participationConfirmed !== true ||
    input.emailProcessingConfirmed !== true
  )
    throw new HttpError(
      400,
      "Conferma entrambe le condizioni per partecipare al pilota.",
    );
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid consent clock");
  const db = getDb();
  const [row] = await db
    .select({
      invitationId: invitations.id,
      acceptedAt: invitations.acceptedAt,
      acceptedVersion: invitations.acceptedVersion,
      expiresAt: invitations.expiresAt,
      revokedAt: invitations.revokedAt,
      disabledAt: companies.disabledAt,
      administratorId: administrators.userId,
    })
    .from(companies)
    .innerJoin(invitations, eq(invitations.companyId, companies.id))
    .leftJoin(administrators, eq(administrators.userId, companies.ownerId))
    .where(eq(companies.ownerId, input.userId))
    .limit(1);
  if (!row || row.revokedAt || row.disabledAt)
    throw new HttpError(404, "Invito non disponibile.");
  if (row.administratorId)
    throw new HttpError(400, "L’account fondatore non partecipa al pilota.");
  if (row.acceptedAt) {
    if (row.acceptedVersion !== PILOT_PARTICIPATION_TERMS_VERSION)
      throw new HttpError(
        409,
        "L’invito contiene una registrazione precedente da verificare con il fondatore.",
      );
    return {
      acceptedAt: row.acceptedAt.toISOString(),
      termsVersion: row.acceptedVersion,
      alreadyAccepted: true,
    };
  }
  if (row.expiresAt <= now)
    throw new HttpError(410, "L’invito è scaduto. Chiedi un nuovo invito.");
  const [accepted] = await db
    .update(invitations)
    .set({
      acceptedAt: now,
      acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
    })
    .where(
      and(
        eq(invitations.id, row.invitationId),
        isNull(invitations.acceptedAt),
        isNull(invitations.acceptedVersion),
        isNull(invitations.revokedAt),
        gt(invitations.expiresAt, now),
      ),
    )
    .returning({
      acceptedAt: invitations.acceptedAt,
      termsVersion: invitations.acceptedVersion,
    });
  if (!accepted?.acceptedAt || !accepted.termsVersion) {
    const [current] = await db
      .select({
        acceptedAt: invitations.acceptedAt,
        termsVersion: invitations.acceptedVersion,
      })
      .from(invitations)
      .where(eq(invitations.id, row.invitationId));
    if (
      current?.acceptedAt &&
      current.termsVersion === PILOT_PARTICIPATION_TERMS_VERSION
    )
      return {
        acceptedAt: current.acceptedAt.toISOString(),
        termsVersion: current.termsVersion,
        alreadyAccepted: true,
      };
    throw new HttpError(
      409,
      "L’invito è cambiato. Ricarica la pagina prima di riprovare.",
    );
  }
  return {
    acceptedAt: accepted.acceptedAt.toISOString(),
    termsVersion: accepted.termsVersion,
    alreadyAccepted: false,
  };
}
