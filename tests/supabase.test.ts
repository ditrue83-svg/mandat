import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { databaseOptions } from "../src/lib/database-config";
import { inspectSetup, setupGroupConfigured } from "../src/lib/setup";

const ref = "abcdefghijklmnopqrst";
const supabase = {
  DATABASE_PROVIDER: "supabase",
  DATABASE_URL: `postgresql://postgres.${ref}:fixture%3Apassword@aws-1-eu-central-2.pooler.supabase.com:5432/postgres`,
  SUPABASE_PROJECT_REF: ref,
  SUPABASE_REGION: "eu-central-2",
  COMPOSE_FILE: "compose.supabase.yml",
};

describe("PostgreSQL gestito senza esporre credenziali o tabelle", () => {
  it("usa Session/direct, verifica TLS e limita i pool senza richiedere un DB Docker", () => {
    const options = databaseOptions(supabase);
    expect(options.ssl).toMatchObject({
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    expect(options.password).toBe("fixture:password");
    expect(options).not.toHaveProperty("connectionString");
    expect(options.max).toBe(3);
    expect(databaseOptions(supabase, "migration").max).toBe(1);
    expect(databaseOptions(supabase, "queue").application_name).toBe(
      "mandat-queue",
    );
    expect(
      databaseOptions({
        ...supabase,
        DATABASE_URL: `postgresql://postgres:fixture@db.${ref}.supabase.co:5432/postgres`,
      }).host,
    ).toBe(`db.${ref}.supabase.co`);
    expect(setupGroupConfigured(inspectSetup(supabase), "database")).toBe(true);
  });

  it("rifiuta pooler transaction, regione/progetto errati, override TLS e provider implicito", () => {
    const invalid = [
      {
        ...supabase,
        DATABASE_URL: supabase.DATABASE_URL.replace(":5432/", ":6543/"),
      },
      {
        ...supabase,
        DATABASE_URL: supabase.DATABASE_URL.replace(
          "eu-central-2",
          "eu-west-1",
        ),
      },
      { ...supabase, SUPABASE_PROJECT_REF: "differentprojectrefab" },
      { ...supabase, SUPABASE_REGION: "eu-central-1" },
      { ...supabase, DATABASE_URL: `${supabase.DATABASE_URL}?sslmode=disable` },
      { ...supabase, DATABASE_URL: `${supabase.DATABASE_URL}?user=another` },
      { ...supabase, DATABASE_PROVIDER: undefined },
      { ...supabase, DATABASE_PROVIDER: "local" },
      {
        ...supabase,
        DATABASE_SSL_CA_BASE64:
          Buffer.from("not-a-certificate").toString("base64"),
      },
      { ...supabase, DATABASE_POOL_MAX: "100" },
    ];
    for (const env of invalid) {
      expect(() => databaseOptions(env)).toThrow();
      try {
        databaseOptions(env);
      } catch (error) {
        expect(String(error)).not.toContain("fixture");
        expect(String(error)).not.toContain(ref);
      }
    }
    expect(
      inspectSetup({ ...supabase, RESTIC_PASSWORD: "fixture:password" }).find(
        (check) => check.id === "RESTIC_PASSWORD_UNIQUE",
      )?.status,
    ).toBe("invalid");
  });

  it("migra due volte; owner operativo, ruoli client bloccati anche con BYPASSRLS e nuovi oggetti", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
        ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
      `);
      const db = drizzle(pg);
      await migrate(db, { migrationsFolder: "drizzle" });
      await migrate(db, { migrationsFolder: "drizzle" });
      await pg.exec(
        `INSERT INTO public.settings(key, value) VALUES ('test', 'true'::jsonb);`,
      );
      const protection = await pg.query<{ total: number; protected: number }>(`
        SELECT count(*)::int total, count(*) FILTER(WHERE relrowsecurity)::int protected
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind='r'
      `);
      expect(protection.rows[0]).toEqual({ total: 24, protected: 24 });
      for (const role of ["anon", "authenticated", "service_role"]) {
        await pg.exec(`SET ROLE ${role}`);
        await expect(pg.query("SELECT * FROM public.session")).rejects.toThrow(
          /permission denied/i,
        );
        await expect(
          pg.query("SELECT * FROM public.companies"),
        ).rejects.toThrow(/permission denied/i);
        await pg.exec("RESET ROLE");
      }
      await pg.exec(
        "CREATE TABLE public.future_internal (id int); CREATE FUNCTION public.future_function() RETURNS int LANGUAGE sql AS 'SELECT 1';",
      );
      const privileges = await pg.query<{
        table_access: boolean;
        function_access: boolean;
      }>(`
        SELECT has_table_privilege(rolname, 'public.future_internal', 'SELECT') table_access,
               has_function_privilege(rolname, 'public.future_function()', 'EXECUTE') function_access
        FROM pg_roles WHERE rolname IN ('anon', 'authenticated', 'service_role')
      `);
      expect(privileges.rows).toHaveLength(3);
      expect(
        privileges.rows.every(
          (row) => !row.table_access && !row.function_access,
        ),
      ).toBe(true);
    } finally {
      await pg.close();
    }
  }, 20000);
});
