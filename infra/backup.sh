#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${DATABASE_PROVIDER:-local}" = "supabase" ]; then
  exec bash infra/backup-supabase.sh
fi
# Variabili Restic fornite dal servizio systemd; mai stamparle.
: "${RESTIC_REPOSITORY:?Configura RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD:?Configura RESTIC_PASSWORD}"
command -v restic >/dev/null
command -v docker >/dev/null
backup_tmp=$(mktemp -d)
chmod 700 "$backup_tmp"
trap 'rm -rf "$backup_tmp"' EXIT
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$backup_tmp/mandat.dump"
test -s "$backup_tmp/mandat.dump"
docker compose exec -T db sh -c 'pg_restore --list' < "$backup_tmp/mandat.dump" > /dev/null
cp .env "$backup_tmp/runtime.env"
chmod 600 "$backup_tmp/runtime.env"
restic backup "$backup_tmp" --tag mandat --host mandat-vps --exclude-caches
restic forget --tag mandat --host mandat-vps --group-by host,tags --keep-daily 14 --keep-weekly 4 --prune
restic check
