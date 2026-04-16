#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 <backup-directory>"
  exit 1
fi

BACKUP_DIR="$1"
DB_DUMP="$BACKUP_DIR/database.sql"
STORAGE_ARCHIVE="$BACKUP_DIR/storage.tar.gz"

if [ ! -f "$DB_DUMP" ]; then
  echo "Missing $DB_DUMP"
  exit 1
fi

if [ ! -f "$STORAGE_ARCHIVE" ]; then
  echo "Missing $STORAGE_ARCHIVE"
  exit 1
fi

echo "[1/4] Restoring PostgreSQL"
cat "$DB_DUMP" | docker compose exec -T db psql -U "${DB_USER:-soundraft}" -d "${DB_NAME:-soundraft}"

echo "[2/4] Preparing storage destination"
if [ -n "${UPLOADS_LOCATION:-}" ]; then
  mkdir -p "${UPLOADS_LOCATION}"
  tar -xzf "$STORAGE_ARCHIVE" -C "${UPLOADS_LOCATION}"
else
  TMP_DIR="$(mktemp -d)"
  tar -xzf "$STORAGE_ARCHIVE" -C "$TMP_DIR"
  docker compose cp "$TMP_DIR/." storage:/data
  rm -rf "$TMP_DIR"
fi

echo "[3/4] Optional: restore .env manually from $BACKUP_DIR/.env"
echo "[4/4] Restarting services"
docker compose restart

echo "Restore complete."
