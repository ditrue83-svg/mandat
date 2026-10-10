import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db";
import {
  account,
  administrators,
  companies,
  invitations,
  session,
  user,
} from "@/db/schema";
import { invitationAllowsLogin } from "./auth";

// Operator-only provisioning for an existing invited account. Never creates a
// user, company or administrator, and never sends credentials through email.
export async function setLoginCredentials(input: {
  email: string;
  username: string;
  password: string;
  replaceExisting?: boolean;
  requireAdministrator?: boolean;
}) {
  const username = input.username.trim().toLowerCase();
  if (!/^[a-z0-9_.]{3,30}$/.test(username))
    throw new Error("Nome utente non valido.");
  if (input.password.length < 4 || input.password.length > 128)
    throw new Error("Password fuori dai limiti consentiti.");
  const passwordHash = await hashPassword(input.password);
  return getDb().transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(user)
      .where(eq(user.email, input.email.trim().toLowerCase()))
      .for("update");
    if (!existing) throw new Error("Account invitato non trovato.");
    const [row] = await tx
      .select({ company: companies, invite: invitations })
      .from(companies)
      .innerJoin(invitations, eq(invitations.companyId, companies.id))
      .where(eq(companies.ownerId, existing.id));
    if (!row || !invitationAllowsLogin(row.invite, row.company.disabledAt))
      throw new Error("Invito non valido o accesso revocato.");
    if (input.requireAdministrator) {
      const [admin] = await tx
        .select()
        .from(administrators)
        .where(eq(administrators.userId, existing.id));
      if (!admin)
        throw new Error(
          "Account fondatore non trovato; nessuna promozione automatica.",
        );
    }
    const [collision] = await tx
      .select()
      .from(user)
      .where(eq(user.username, username));
    if (collision && collision.id !== existing.id)
      throw new Error("Nome utente già assegnato.");
    const credentials = await tx
      .select()
      .from(account)
      .where(
        and(
          eq(account.userId, existing.id),
          eq(account.providerId, "credential"),
        ),
      );
    if (credentials.length > 1) throw new Error("Account credenziali ambiguo.");
    if ((existing.username || credentials.length) && !input.replaceExisting)
      throw new Error(
        "Credenziali già configurate: sostituzione esplicita necessaria.",
      );
    await tx
      .update(user)
      .set({ username, updatedAt: new Date() })
      .where(eq(user.id, existing.id));
    if (credentials[0]) {
      await tx
        .update(account)
        .set({ password: passwordHash, updatedAt: new Date() })
        .where(eq(account.id, credentials[0].id));
    } else {
      await tx
        .insert(account)
        .values({
          id: crypto.randomUUID(),
          userId: existing.id,
          accountId: existing.id,
          providerId: "credential",
          password: passwordHash,
        });
    }
    // A reset invalidates existing sessions instead of leaving old access live.
    await tx.delete(session).where(eq(session.userId, existing.id));
    return { username };
  });
}
