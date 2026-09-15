import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { expect, it } from "vitest";

const restoreAccess = readFileSync("infra/restore-access.sql", "utf8");

it("restores server-only permissions for existing and future objects without touching managed schemas", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA drizzle; CREATE SCHEMA pgboss; CREATE SCHEMA auth;
      CREATE TABLE public.company_private(id int); INSERT INTO public.company_private VALUES (42);
      CREATE TABLE drizzle.history(id int); CREATE TABLE pgboss.job(id int);
      CREATE TABLE auth.managed(id int); GRANT SELECT ON auth.managed TO authenticated;
      CREATE SEQUENCE public.private_sequence;
      CREATE FUNCTION public.private_function() RETURNS int LANGUAGE sql AS 'SELECT 42';
      GRANT ALL ON SCHEMA public,drizzle,pgboss TO PUBLIC,anon,authenticated,service_role;
      GRANT ALL ON public.company_private,drizzle.history,pgboss.job TO PUBLIC,anon,authenticated,service_role;
      GRANT ALL ON SEQUENCE public.private_sequence TO PUBLIC,anon,authenticated,service_role;
      GRANT EXECUTE ON FUNCTION public.private_function() TO anon,authenticated,service_role;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO authenticated;
      ALTER DEFAULT PRIVILEGES GRANT ALL ON SEQUENCES TO service_role;
      ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon;
    `);
    await db.exec(restoreAccess);
    await db.exec(restoreAccess);
    await db.exec(`
      CREATE TABLE public.future_private(id int);
      CREATE SEQUENCE pgboss.future_sequence;
      CREATE FUNCTION drizzle.future_function() RETURNS int LANGUAGE sql AS 'SELECT 42';
    `);
    const { rows } = await db.query<{ allowed: boolean }>(`
      SELECT has_schema_privilege(r.oid,n.oid,'USAGE,CREATE') OR EXISTS (
        SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND
          CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
            WHEN c.relkind IN ('r','p','v','m') THEN has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') ELSE false END
      ) OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid AND has_function_privilege(r.oid,p.oid,'EXECUTE')) AS allowed
      FROM pg_roles r CROSS JOIN pg_namespace n
      WHERE r.rolname IN ('anon','authenticated','service_role') AND n.nspname IN ('public','drizzle','pgboss')
    `);
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => !row.allowed)).toBe(true);
    expect(
      (await db.query("SELECT * FROM public.company_private")).rows,
    ).toEqual([{ id: 42 }]);
    expect(
      (
        await db.query(
          "SELECT relrowsecurity FROM pg_class WHERE oid='public.company_private'::regclass",
        )
      ).rows,
    ).toEqual([{ relrowsecurity: true }]);
    expect(
      (
        await db.query(
          "SELECT has_table_privilege('authenticated','auth.managed','SELECT') AS allowed",
        )
      ).rows,
    ).toEqual([{ allowed: true }]);
  } finally {
    await db.close();
  }
});
