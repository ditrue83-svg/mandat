import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { username } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import * as schema from "@/db/schema";
import { appUrl, isDemo } from "./config";
export function invitationAllowsLogin(
  invite:
    | { revokedAt: Date | null; acceptedAt: Date | null; expiresAt: Date }
    | undefined,
  disabledAt: Date | null,
  now = new Date(),
) {
  return (
    !!invite &&
    !disabledAt &&
    !invite.revokedAt &&
    (!!invite.acceptedAt || invite.expiresAt > now)
  );
}
async function allowedUser(userId: string) {
  const rows = await getDb()
    .select({ invite: schema.invitations, company: schema.companies })
    .from(schema.companies)
    .innerJoin(
      schema.invitations,
      eq(schema.invitations.companyId, schema.companies.id),
    )
    .where(eq(schema.companies.ownerId, userId))
    .limit(1);
  return (
    rows.length > 0 &&
    invitationAllowsLogin(rows[0].invite, rows[0].company.disabledAt)
  );
}
function createAuth() {
  if (isDemo()) throw new Error("Autenticazione reale disabilitata nella demo");
  if ((process.env.BETTER_AUTH_SECRET?.length ?? 0) < 32)
    throw new Error("Configurare BETTER_AUTH_SECRET");
  return betterAuth({
    appName: "Mandat",
    baseURL: appUrl(),
    secret: process.env.BETTER_AUTH_SECRET,
    database: drizzleAdapter(getDb(), { provider: "pg", schema }),
    trustedOrigins: [appUrl()],
    emailAndPassword: { enabled: true, disableSignUp: true },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    advanced: {
      useSecureCookies: appUrl().startsWith("https:"),
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 30,
      customRules: {
        "/sign-in/username": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (data) => {
            if (!(await allowedUser(data.userId)))
              throw new APIError("FORBIDDEN", {
                message: "Invito non valido o accesso revocato.",
              });
            return { data };
          },
        },
      },
    },
    plugins: [username({ displayUsername: false, immutableUsername: true })],
  });
}
let instance: ReturnType<typeof createAuth> | undefined;
export function getAuth() {
  return (instance ??= createAuth());
}
