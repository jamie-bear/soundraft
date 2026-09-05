#!/usr/bin/env bash
set -euo pipefail
umask 077
[ $# -eq 1 ] || { echo 'Usage: RESTORE_PG_DATA_LOCATION=/fresh/db RESTORE_UPLOADS_LOCATION=/fresh/storage scripts/restore.sh BACKUP' >&2; exit 1; }
command -v python3 >/dev/null || { echo 'python3 is required for safe restore validation' >&2; exit 1; }
BACKUP_DIR="$(realpath "$1")"
PG_TARGET="${RESTORE_PG_DATA_LOCATION:?Set a fresh database directory}"
STORAGE_TARGET="${RESTORE_UPLOADS_LOCATION:?Set a fresh storage directory}"
OVERRIDE="${RESTORE_OVERRIDE_FILE:-$BACKUP_DIR/restore-targets.json}"
# Validate canonical paths and archive members BEFORE stopping any services.
python3 "$(dirname "$0")/validate-restore.py" "$BACKUP_DIR" "$PG_TARGET" "$STORAGE_TARGET" "$OVERRIDE"
PG_TARGET="$(realpath "$PG_TARGET")"
STORAGE_TARGET="$(realpath "$STORAGE_TARGET")"
OVERRIDE="$(realpath "$OVERRIDE")"
BASE_COMPOSE="${COMPOSE_FILE:-docker-compose.yml}"
export COMPOSE_FILE="$BASE_COMPOSE:$OVERRIDE"
echo '[1/4] Stopping the target project (existing data directories are retained)'
docker compose down
echo '[2/4] Restoring objects into the validated empty target'
tar -xzf "$BACKUP_DIR/storage.tar.gz" -C "$STORAGE_TARGET" --no-same-owner
docker compose up -d --wait --wait-timeout 120 db storage
echo '[3/4] Restoring PostgreSQL'
docker compose exec -T db sh -c 'exec pg_restore --exit-on-error --clean --if-exists --no-owner --no-privileges -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$BACKUP_DIR/database.dump"
echo '[4/4] Comparing restored counts and every referenced media hash'
ACTUAL="$(mktemp)"
trap 'rm -f -- "$ACTUAL"' EXIT
docker compose run --rm --no-deps -T api node scripts/verify-storage.js > "$ACTUAL"
cmp "$BACKUP_DIR/inventory.jsonl" "$ACTUAL" || { echo 'Restore verification failed; API remains stopped' >&2; exit 1; }
if [ -f "$BACKUP_DIR/secrets.env.age" ] && [ -n "${RESTORE_AGE_IDENTITY:-}" ] && [ -n "${RESTORE_SECRETS_OUTPUT:-}" ]; then
  [ ! -e "$RESTORE_SECRETS_OUTPUT" ] || { echo 'Refusing to overwrite secrets output' >&2; exit 1; }
  age -d -i "$RESTORE_AGE_IDENTITY" -o "$RESTORE_SECRETS_OUTPUT" "$BACKUP_DIR/secrets.env.age"
fi
echo 'Verified restore complete; API remains stopped. Keep using this override:'
printf 'COMPOSE_FILE=%q docker compose up -d api\n' "$COMPOSE_FILE"
