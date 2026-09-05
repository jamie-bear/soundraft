#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/soundraft-gate.XXXXXX")"
export COMPOSE_FILE="$PWD/.github/recovery.compose.yml"
export COMPOSE_PROJECT_NAME="soundraft-gate-$$"
export PG_DATA_LOCATION="$ROOT/source-postgres" UPLOADS_LOCATION="$ROOT/source-storage"
export DB_USER=gate_owner DB_NAME=gate_catalog S3_BUCKET=gate-media
export DB_PASSWORD="$(openssl rand -hex 24)" JWT_SECRET="$(openssl rand -hex 32)"
export S3_ACCESS_KEY="$(openssl rand -hex 12)" S3_SECRET_KEY="$(openssl rand -hex 24)"
export ADMIN_EMAIL=gate@example.com ADMIN_PASSWORD="$(openssl rand -hex 24)"
cleanup() { docker compose down -v >/dev/null; echo "Isolated gate files retained at $ROOT"; }
trap cleanup EXIT
docker compose up -d --build --wait --wait-timeout 180
docker compose exec -T api node test/recovery-seed.js
export E2E_BASE_URL="http://$(docker compose port api 8080)" E2E_EMAIL="$ADMIN_EMAIL" E2E_PASSWORD="$ADMIN_PASSWORD"
(cd client && npm run test:browser)
node server/test/service-faults.js
bash scripts/backup.sh "$ROOT/backup"
bash scripts/restore-drill.sh "$ROOT/backup"
# Corrupted archives must be rejected before any service is touched.
cp -a "$ROOT/backup" "$ROOT/corrupt"
printf corruption >> "$ROOT/corrupt/storage.tar.gz"
if bash scripts/restore-drill.sh "$ROOT/corrupt"; then echo 'Corrupt backup incorrectly passed' >&2; exit 1; fi
# Losing a referenced object must fail the inventory, and therefore backup.
docker compose exec -T api node test/remove-recovery-object.js
if bash scripts/backup.sh "$ROOT/missing-object"; then echo 'Missing object incorrectly passed' >&2; exit 1; fi
echo 'PASS: real service browser journeys, restore counts/hashes and negative recovery checks'
