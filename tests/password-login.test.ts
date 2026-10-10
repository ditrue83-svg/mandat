import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
const context = vi.hoisted(() => ({
  db: undefined as unknown,
  headers: new Headers(),
  mail: vi.fn(),
}));
vi.mock("@/db", () => ({ getDb: () => context.db }));
vi.mock("next/headers", () => ({ headers: async () => context.headers }));
vi.mock("@/lib/mail", () => ({
  sendMail: context.mail,
  emailLayout: (s: string) => s,
  escapeHtml: (s: string) => s,
}));
import { POST } from "../src/app/api/auth/[...all]/route";
import { setLoginCredentials } from "../src/lib/login-credentials";
import { currentViewer, requireViewer } from "../src/lib/viewer";
import { PILOT_PARTICIPATION_TERMS_VERSION } from "../src/lib/pilot-participation";
const pg = new PGlite();
const db = drizzle(pg, { schema });
const origin = "http://localhost:3456";
const founderPassword = "test";
function request(
  path: string,
  body: unknown,
  ip = "192.0.2.10",
  requestOrigin = origin,
) {
  return POST(
    new Request(`${origin}/api/auth${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin: requestOrigin,
        "x-real-ip": ip,
      },
      body: JSON.stringify(body),
    }),
  );
}
function signIn(username: string, password: string, ip?: string) {
  return request("/sign-in/username", { username, password }, ip);
}
function useSession(response: Response) {
  context.headers = new Headers({
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  });
}
beforeAll(async () => {
  context.db = db;
  process.env.APP_MODE = "live";
  process.env.APP_URL = origin;
  process.env.DATABASE_URL = "postgres://test:test@localhost/test";
  process.env.BETTER_AUTH_SECRET =
    "isolated-test-secret-never-for-production-0123456789";
  await migrate(db, { migrationsFolder: "drizzle" });
});
beforeEach(async () => {
  await db.delete(schema.user);
  await db.delete(schema.rateLimit);
  context.headers = new Headers();
  context.mail.mockClear();
  for (const id of ["founder", "firm"]) {
    await db
      .insert(schema.user)
      .values({ id, name: id, email: `${id}@example.invalid` });
    await db
      .insert(schema.companies)
      .values({ id: `${id}-company`, ownerId: id, profile: {} as never });
    await db.insert(schema.invitations).values({
      id: `${id}-invite`,
      email: `${id}@example.invalid`,
      companyId: `${id}-company`,
      expiresAt: new Date(Date.now() + 86400000),
      acceptedAt: new Date(),
      acceptedVersion: PILOT_PARTICIPATION_TERMS_VERSION,
    });
  }
  await db.insert(schema.administrators).values({ userId: "founder" });
  await setLoginCredentials({
    email: "founder@example.invalid",
    username: "fondatore",
    password: founderPassword,
    requireAdministrator: true,
  });
  await setLoginCredentials({
    email: "firm@example.invalid",
    username: "ditta",
    password: "different-firm-password",
  });
});
afterAll(async () => {
  await pg.close();
});
describe("Accesso senza email", () => {
  it("una password di quattro caratteri accede solo al fondatore, con hash e cookie protetto", async () => {
    const response = await signIn("FONDATORE", founderPassword);
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    useSession(response);
    expect(await currentViewer()).toMatchObject({
      userId: "founder",
      companyId: "founder-company",
      admin: true,
    });
    const [credential] = await db
      .select()
      .from(schema.account)
      .where(eq(schema.account.userId, "founder"));
    expect(credential.password).not.toBe(founderPassword);
    expect(context.mail).not.toHaveBeenCalled();
  });
  it("rifiuta password errata, account sconosciuto e password del fondatore su altra ditta", async () => {
    expect((await signIn("fondatore", "wrong")).status).toBe(401);
    expect((await signIn("unknown", founderPassword)).status).toBe(401);
    expect((await signIn("ditta", founderPassword)).status).toBe(401);
    expect(await currentViewer()).toBeNull();
    expect(await db.select().from(schema.user)).toHaveLength(2);
    expect(context.mail).not.toHaveBeenCalled();
  });
  it("la ditta mantiene la sua identità e non ottiene privilegi di amministratore", async () => {
    const response = await signIn("ditta", "different-firm-password");
    expect(response.status).toBe(200);
    useSession(response);
    expect(await currentViewer()).toMatchObject({
      userId: "firm",
      companyId: "firm-company",
      admin: false,
    });
    await expect(requireViewer({ admin: true })).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      setLoginCredentials({
        email: "firm@example.invalid",
        username: "ditta",
        password: "test",
        replaceExisting: true,
        requireAdministrator: true,
      }),
    ).rejects.toThrow("nessuna promozione");
  });
  it("chiude OTP, accesso email, registrazione e reset pubblico", async () => {
    for (const path of [
      "/email-otp/send-verification-otp",
      "/sign-in/email-otp",
      "/sign-in/email",
      "/sign-up/email",
      "/request-password-reset",
    ]) {
      expect(
        (
          await request(path, {
            email: "founder@example.invalid",
            password: founderPassword,
          })
        ).status,
      ).toBe(404);
    }
    expect(context.mail).not.toHaveBeenCalled();
  });
  it("revoca e disabilitazione bloccano sessioni esistenti e nuovi accessi", async () => {
    const response = await signIn("ditta", "different-firm-password");
    useSession(response);
    await db
      .update(schema.invitations)
      .set({ revokedAt: new Date() })
      .where(eq(schema.invitations.id, "firm-invite"));
    expect(await currentViewer()).toBeNull();
    expect((await signIn("ditta", "different-firm-password")).status).toBe(403);
    await db
      .update(schema.companies)
      .set({ disabledAt: new Date() })
      .where(eq(schema.companies.id, "founder-company"));
    expect((await signIn("fondatore", founderPassword)).status).toBe(403);
  });
  it("il reset revoca sessioni e password precedenti, senza cambiare ruoli o ditta", async () => {
    useSession(await signIn("fondatore", founderPassword));
    await expect(
      setLoginCredentials({
        email: "firm@example.invalid",
        username: "fondatore",
        password: "test",
        replaceExisting: true,
      }),
    ).rejects.toThrow("già assegnato");
    await setLoginCredentials({
      email: "founder@example.invalid",
      username: "fondatore",
      password: "new-private-password",
      replaceExisting: true,
      requireAdministrator: true,
    });
    expect(await currentViewer()).toBeNull();
    expect((await signIn("fondatore", founderPassword)).status).toBe(401);
    expect((await signIn("fondatore", "new-private-password")).status).toBe(
      200,
    );
    expect(await db.select().from(schema.administrators)).toEqual([
      { userId: "founder" },
    ]);
    expect(await db.select().from(schema.companies)).toHaveLength(2);
  });
  it("limita tentativi ripetuti e rifiuta origini estranee", async () => {
    expect(
      (
        await request(
          "/sign-in/username",
          { username: "fondatore", password: founderPassword },
          "192.0.2.99",
          "https://other.example.invalid",
        )
      ).status,
    ).toBe(403);
    for (let i = 0; i < 5; i++)
      expect((await signIn("fondatore", "wrong", "192.0.2.98")).status).toBe(
        401,
      );
    expect((await signIn("fondatore", "wrong", "192.0.2.98")).status).toBe(429);
  });
});
