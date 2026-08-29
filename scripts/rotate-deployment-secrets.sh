#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPOSITORY_ROOT"

if [ ! -f .env ]; then
    echo "Missing .env; copy .env.example and configure it first." >&2
    exit 1
fi

command -v docker >/dev/null 2>&1 || { echo "docker is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required" >&2; exit 1; }

set -a
# The file is deployment-owned and expected to contain shell-safe values from
# .env.example or rotate-local-secrets.js.
. ./.env
set +a

DB_USER=${DB_USER:-soundraft}
DB_NAME=${DB_NAME:-soundraft}

case "$DB_USER" in
    *[!a-zA-Z0-9_]*) echo "DB_USER contains unsupported characters" >&2; exit 1 ;;
esac

NEW_DB_PASSWORD=$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)

echo "Stopping the API before coordinated credential rotation..."
docker compose stop api

echo "Rotating the password of the persistent PostgreSQL role..."
docker compose exec -T db psql \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 \
    -c "ALTER ROLE \"$DB_USER\" WITH PASSWORD '$NEW_DB_PASSWORD';"

ROTATED_DB_PASSWORD=$NEW_DB_PASSWORD node - <<'NODE'
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');

const envPath = '.env';
const replacements = {
    JWT_SECRET: crypto.randomBytes(64).toString('hex'),
    ADMIN_PASSWORD: crypto.randomBytes(24).toString('base64url'),
    DB_PASSWORD: process.env.ROTATED_DB_PASSWORD,
    S3_ACCESS_KEY: `SR${crypto.randomBytes(9).toString('hex')}`,
    S3_SECRET_KEY: crypto.randomBytes(32).toString('base64url'),
};
const original = fs.readFileSync(envPath, 'utf8');
const lines = original.split(/\r?\n/);
const seen = new Set();
for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !Object.hasOwn(replacements, match[1])) continue;
    seen.add(match[1]);
    lines[index] = `${match[1]}=${replacements[match[1]]}`;
}
for (const [name, value] of Object.entries(replacements)) {
    if (!seen.has(name)) lines.push(`${name}=${value}`);
}
fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });
NODE
unset ROTATED_DB_PASSWORD NEW_DB_PASSWORD

echo "Recreating services with the new credentials..."
docker compose up -d --force-recreate db storage api
echo "Credential rotation complete. Existing sessions and share links are invalidated on API startup."
