#!/usr/bin/env bash
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="${1:-./backups/$STAMP}"

mkdir -p "$OUT_DIR"

echo "[1/3] Exporting PostgreSQL to $OUT_DIR/database.sql"
docker compose exec -T db pg_dump -U "${DB_USER:-soundraft}" "${DB_NAME:-soundraft}" > "$OUT_DIR/database.sql"

echo "[2/3] Archiving object storage"
if [ -n "${UPLOADS_LOCATION:-}" ] && [ -d "${UPLOADS_LOCATION}" ]; then
  tar -czf "$OUT_DIR/storage.tar.gz" -C "${UPLOADS_LOCATION}" .
else
  docker compose cp storage:/data "$OUT_DIR/storage"
  tar -czf "$OUT_DIR/storage.tar.gz" -C "$OUT_DIR/storage" .
  rm -rf "$OUT_DIR/storage"
fi

echo "[3/3] Copying .env"
cp .env "$OUT_DIR/.env"

echo "Backup complete: $OUT_DIR"
