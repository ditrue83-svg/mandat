import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { administrators, companies, invitations } from "@/db/schema";
import { getAuth, invitationAllowsLogin } from "./auth";
import { isDemo } from "./config";
import { demoViewer } from "./demo";
import type { Viewer } from "./domain";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "./pilot-participation";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function viewerNeedsPilotAcceptance(
  viewer: Pick<
    Viewer,
    "demo" | "admin" | "invitationAcceptedAt" | "invitationAcceptanceVersion"
  >,
) {
  return (
    !viewer.demo &&
    !viewer.admin &&
    (!viewer.invitationAcceptedAt ||
      viewer.invitationAcceptanceVersion !== PILOT_PARTICIPATION_TERMS_VERSION)
  );
}
export async function currentViewer(): Promise<Viewer | null> {
  if (isDemo()) return demoViewer;
  if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) return null;
  const sess = await getAuth().api.getSession({ headers: await headers() });
  if (!sess) return null;
  const [row] = await getDb()
    .select({ company: companies, invite: invitations })
    .from(companies)
    .innerJoin(invitations, eq(invitations.companyId, companies.id))
    .where(eq(companies.ownerId, sess.user.id))
    .limit(1);
  if (!row || !invitationAllowsLogin(row.invite, row.company.disabledAt))
    return null;
  const [admin] = await getDb()
    .select()
    .from(administrators)
    .where(eq(administrators.userId, sess.user.id))
    .limit(1);
  return {
    userId: sess.user.id,
    companyId: row.company.id,
    name: sess.user.name,
    email: sess.user.email,
    admin: !!admin,
    demo: false,
    invitationAcceptedAt: row.invite.acceptedAt?.toISOString() ?? null,
    invitationAcceptanceVersion: row.invite.acceptedVersion,
    profile: row.company.profile,
  };
}
export async function requireViewer({
  admin = false,
  mutation = false,
  allowPendingInvitation = false,
} = {}): Promise<Viewer> {
  const v = await currentViewer();
  if (!v) throw new HttpError(401, "Accedi per continuare.");
  if (mutation && v.demo)
    throw new HttpError(403, "La demo non modifica dati reali.");
  if (admin && !v.admin)
    throw new HttpError(403, "Accesso riservato al fondatore.");
  if (!allowPendingInvitation && viewerNeedsPilotAcceptance(v))
    throw new HttpError(
      403,
      "Accetta prima la partecipazione al pilota per continuare.",
    );
  return v;
}
export async function pageViewer(admin = false) {
  const v = await currentViewer();
  if (!v) redirect("/accedi");
  if (admin && !v.admin) redirect("/");
  if (viewerNeedsPilotAcceptance(v)) redirect("/partecipa");
  return v;
}
export async function needsOnboarding(companyId: string) {
  const [c] = await getDb()
    .select({ at: companies.onboardedAt })
    .from(companies)
    .where(eq(companies.id, companyId));
  return !c?.at;
}
