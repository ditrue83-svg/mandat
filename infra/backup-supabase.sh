#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${RESTIC_REPOSITORY:?Configura RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD:?Configura RESTIC_PASSWORD}"
command -v restic >/dev/null
command -v docker >/dev/null
backup_tmp=$(mktemp -d)
chmod 700 "$backup_tmp"
trap 'rm -rf "$backup_tmp"' EXIT
client_image=${DATABASE_CLIENT_IMAGE:-postgres:17-bookworm}

docker compose -f compose.supabase.yml run --rm -T --no-deps \
  --user "$(id -u):$(id -g)" -v "$backup_tmp:/backup" \
  worker node --import tsx scripts/prepare-pg-backup.ts

# Dedicated project only: public is Mandat's schema. Exclude managed Supabase
# schemas auth/storage/realtime; include our migration ledger and pending jobs.
if ! docker run --rm --user "$(id -u):$(id -g)" \
  --env-file "$backup_tmp/pg.env" -v "$backup_tmp:/backup" "$client_image" \
  pg_dump --format=custom --no-owner --no-acl \
    --schema=public --schema=drizzle --schema=pgboss --file=/backup/mandat.dump \
  2>"$backup_tmp/pg-error.log"; then
  printf '%s\n' 'Backup Supabase non riuscito: verificare rete, CA, permessi e versione del client PostgreSQL.' >&2
  exit 1
fi
test -s "$backup_tmp/mandat.dump"
docker run --rm -v "$backup_tmp:/backup:ro" "$client_image" \
  pg_restore --list /backup/mandat.dump > /dev/null
rm -f "$backup_tmp/pg.env" "$backup_tmp/ca.pem" "$backup_tmp/pg-error.log"
cp .env "$backup_tmp/runtime.env"
chmod 600 "$backup_tmp/runtime.env"
restic backup "$backup_tmp" --tag mandat --host mandat-vps --exclude-caches
restic forget --tag mandat --host mandat-vps --group-by host,tags --keep-daily 14 --keep-weekly 4 --prune
restic check
