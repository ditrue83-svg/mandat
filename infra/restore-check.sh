#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [ "${DATABASE_PROVIDER:-local}" = "supabase" ]; then
  exec bash infra/restore-check-supabase.sh
fi
# Ripristino di prova in database separato: non sovrascrive la produzione.
: "${RESTIC_REPOSITORY:?Configura RESTIC_REPOSITORY}"
: "${RESTIC_PASSWORD:?Configura RESTIC_PASSWORD}"
restore_tmp=$(mktemp -d)
chmod 700 "$restore_tmp"
trap 'rm -rf "$restore_tmp"' EXIT
restic restore latest --tag mandat --host mandat-vps --target "$restore_tmp"
restore_dump=$(find "$restore_tmp" -name mandat.dump -type f -print -quit)
test -n "$restore_dump"
docker compose exec -T db sh -c 'createdb -U "$POSTGRES_USER" mandat_restore_check'
docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d mandat_restore_check --exit-on-error --no-owner' < "$restore_dump"
docker compose exec -T db sh -c 'psql -U "$POSTGRES_USER" -d mandat_restore_check -v ON_ERROR_STOP=1 -c "SELECT count(*) FROM companies; SELECT count(*) FROM publication_versions;"'
docker compose exec -T db sh -c 'dropdb -U "$POSTGRES_USER" mandat_restore_check'
printf '%s\n' 'Ripristino del backup verificato in database separato.'
