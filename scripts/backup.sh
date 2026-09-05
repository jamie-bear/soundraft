#!/usr/bin/env bash
set -euo pipefail
umask 077
# Run from the repository root with the current API image already built.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_DIR="${1:-./backups/$STAMP}"
[ ! -e "$FINAL_DIR" ] || { echo "Refusing to overwrite $FINAL_DIR" >&2; exit 1; }
mkdir -p "$(dirname "$FINAL_DIR")"
RUNNING="$(docker compose ps --status running --services)"
for service in db storage; do
  grep -qx "$service" <<< "$RUNNING" || { echo "$service must be running before backup" >&2; exit 1; }
done
STAGE_DIR="$(mktemp -d "$(dirname "$FINAL_DIR")/.soundraft-backup.XXXXXX")"
RESTART=()
grep -qx api <<< "$RUNNING" && RESTART+=(api)
RESTART+=(storage)
QUIESCED=false
cleanup() {
  local result=$?
  if [ "$QUIESCED" = true ]; then docker compose start "${RESTART[@]}" >&2 || result=1; fi
  if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then rm -r -- "$STAGE_DIR"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
echo "[1/5] Quiescing writes and hashing referenced objects"
QUIESCED=true
docker compose stop api
docker compose run --rm --no-deps -T api node scripts/verify-storage.js > "$STAGE_DIR/inventory.jsonl"
echo "[2/5] Dumping PostgreSQL using the container's configured database/user"
docker compose exec -T db sh -c 'exec pg_dump --format=custom --compress=6 --no-owner --no-privileges -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$STAGE_DIR/database.dump"
echo "[3/5] Archiving quiesced storage"
docker compose stop storage
STORAGE_STAGE="$(mktemp -d "$STAGE_DIR/storage.XXXXXX")"
docker compose cp storage:/data/. "$STORAGE_STAGE/"
tar -czf "$STAGE_DIR/storage.tar.gz" -C "$STORAGE_STAGE" .
rm -r -- "$STORAGE_STAGE"
echo "[4/5] Recording integrity manifest"
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null || { echo 'age is required for encrypted secrets' >&2; exit 1; }
  age -r "$BACKUP_AGE_RECIPIENT" -o "$STAGE_DIR/secrets.env.age" .env
fi
printf '{"format_version":3,"created_at":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STAGE_DIR/manifest.json"
(
  cd "$STAGE_DIR"
  sha256sum database.dump storage.tar.gz manifest.json inventory.jsonl > SHA256SUMS
  if [ -f secrets.env.age ]; then sha256sum secrets.env.age >> SHA256SUMS; fi
)
echo "[5/5] Publishing backup and restoring the original running services"
mv -T -- "$STAGE_DIR" "$FINAL_DIR"
STAGE_DIR=""
docker compose start "${RESTART[@]}"
QUIESCED=false
echo "Backup complete: $FINAL_DIR (contains private data; encrypt off-host copies)"
