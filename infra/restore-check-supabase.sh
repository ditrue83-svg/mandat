#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RESTIC_REPOSITORY:?Configura RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD:?Configura RESTIC_PASSWORD}"
command -v restic >/dev/null
command -v docker >/dev/null
restore_tmp=$(mktemp -d)
chmod 700 "$restore_tmp"
restore_container=""
cleanup() {
  local cleanup_status=$?
  if [ -n "$restore_container" ] && ! docker rm -fv "$restore_container" >/dev/null; then
    printf '%s\n' 'Pulizia Docker non riuscita: rimuovere il container di ripristino e il suo volume prima di completare il collaudo.' >&2
    cleanup_status=1
  fi
  if ! rm -rf "$restore_tmp"; then cleanup_status=1; fi
  exit "$cleanup_status"
}
trap cleanup EXIT
restic restore latest --tag mandat --host mandat-vps --target "$restore_tmp"
restore_dump=$(find "$restore_tmp" -name mandat.dump -type f -print -quit)
test -n "$restore_dump"
client_image=${DATABASE_CLIENT_IMAGE:-postgres:17-bookworm}
# A fresh container with no network or published port; never connect to Supabase
# during a restore test. The password is ephemeral and is not written to logs.
restore_password=$(openssl rand -hex 24)
restore_container=$(docker run -d --network none \
  -e "POSTGRES_PASSWORD=$restore_password" -e POSTGRES_DB=mandat_restore_check "$client_image")
restore_ready=false
for attempt in $(seq 1 30); do
  if docker exec "$restore_container" pg_isready -h 127.0.0.1 -U postgres -d mandat_restore_check >/dev/null 2>&1; then
    restore_ready=true
    break
  fi
  sleep 1
done
if [ "$restore_ready" != true ]; then
  printf '%s\n' 'Il database di ripristino non è diventato disponibile entro il limite.' >&2
  exit 1
fi
# The schema-filtered dump includes CREATE SCHEMA public. Remove only the fresh
# container's empty default schema; without CASCADE, unexpected objects stop us.
docker exec "$restore_container" psql -U postgres -d mandat_restore_check \
  -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;'
docker exec -i "$restore_container" pg_restore -U postgres -d mandat_restore_check \
  --exit-on-error --single-transaction --no-owner --no-acl < "$restore_dump"
# Optional release rehearsal. The migration container shares only the fresh
# database's network namespace (network=none), and receives no production env.
if [ -n "${RESTORE_CHECK_WORKER_IMAGE:-}" ]; then
  docker image inspect "$RESTORE_CHECK_WORKER_IMAGE" >/dev/null
  printf 'DATABASE_PROVIDER=local\nDATABASE_URL=postgresql://postgres:%s@127.0.0.1:5432/mandat_restore_check\n' \
    "$restore_password" > "$restore_tmp/migration.env"
  chmod 600 "$restore_tmp/migration.env"
  docker run --rm --pull=never --network "container:$restore_container" \
    --env-file "$restore_tmp/migration.env" --entrypoint node \
    "$RESTORE_CHECK_WORKER_IMAGE" --import tsx scripts/migrate.ts
fi
# The dump deliberately omits ACLs. Reapply the server-only access policy to
# existing and future objects, including roles that can bypass row policies.
docker exec -i "$restore_container" psql -U postgres -d mandat_restore_check \
  -v ON_ERROR_STOP=1 < infra/restore-access.sql
docker exec -i "$restore_container" psql -U postgres -d mandat_restore_check \
  -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles r CROSS JOIN pg_namespace n
    WHERE r.rolname IN ('anon', 'authenticated', 'service_role')
      AND n.nspname IN ('public', 'drizzle', 'pgboss')
      AND (has_schema_privilege(r.oid,n.oid,'USAGE,CREATE') OR EXISTS (
        SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND
          CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
            WHEN c.relkind IN ('r','p','v','m','f') THEN has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
            ELSE false END
      ) OR EXISTS (
        SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid AND has_function_privilege(r.oid,p.oid,'EXECUTE')
      ))
  ) THEN RAISE EXCEPTION 'Client access remained after restore'; END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity)
  THEN RAISE EXCEPTION 'RLS missing after restore'; END IF;
END $$;
SQL
docker exec "$restore_container" psql -U postgres -d mandat_restore_check \
  -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM public.companies; SELECT count(*) FROM public.publication_versions; SELECT count(*) FROM public.notifications; SELECT count(*) FROM drizzle.__drizzle_migrations; SELECT count(*) FROM pgboss.queue;'
printf '%s\n' 'Ripristino Supabase verificato in PostgreSQL isolato, inclusi RLS e privilegi dei ruoli client.'
