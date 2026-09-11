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
  -v ON_ERROR_STOP=1 -c 'DROP SCHEMA public;'
docker exec -i "$restore_container" pg_restore -U postgres -d mandat_restore_check \
  --exit-on-error --single-transaction --no-owner --no-acl < "$restore_dump"
docker exec "$restore_container" psql -U postgres -d mandat_restore_check \
  -v ON_ERROR_STOP=1 -c 'SELECT count(*) FROM public.companies; SELECT count(*) FROM public.publication_versions; SELECT count(*) FROM public.notifications; SELECT count(*) FROM drizzle.__drizzle_migrations; SELECT count(*) FROM pgboss.queue;'
printf '%s\n' 'Ripristino Supabase verificato in PostgreSQL isolato, senza modificare il database remoto.'
