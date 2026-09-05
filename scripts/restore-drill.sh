#!/usr/bin/env bash
set -euo pipefail
umask 077
[ $# -eq 1 ] || { echo 'Usage: scripts/restore-drill.sh BACKUP' >&2; exit 1; }
DRILL_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/soundraft-restore-drill.XXXXXX")"
export COMPOSE_PROJECT_NAME="soundraft-drill-$(date +%s)-$$"
export RESTORE_PG_DATA_LOCATION="$DRILL_ROOT/postgres"
export RESTORE_UPLOADS_LOCATION="$DRILL_ROOT/storage"
export RESTORE_OVERRIDE_FILE="$DRILL_ROOT/targets.json"
cleanup() {
  local result=$?
  if [ -f "$RESTORE_OVERRIDE_FILE" ]; then
    COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}:$RESTORE_OVERRIDE_FILE" docker compose down -v >&2 || result=1
  fi
  echo "Drill files retained for inspection: $DRILL_ROOT" >&2
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bash "$(dirname "$0")/restore.sh" "$1"
echo 'Restore drill passed: database counts and complete media hashes match.'
