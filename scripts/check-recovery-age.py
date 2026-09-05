"""Read-only monitoring output. Unknown/missing evidence fails the check."""
import argparse
import datetime as dt
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('backup', type=Path)
parser.add_argument('restore_receipt', type=Path)
parser.add_argument('--backup-hours', type=int, default=24)
parser.add_argument('--restore-days', type=int, default=30)
args = parser.parse_args()
now = dt.datetime.now(dt.timezone.utc)
alerts = []
for label, file, field, seconds in [
    ('backup', args.backup / 'manifest.json', 'created_at', args.backup_hours * 3600),
    ('restore', args.restore_receipt, 'verified_at', args.restore_days * 86400),
]:
    try:
        evidence = json.loads(file.read_text())
        when = dt.datetime.fromisoformat(evidence[field].replace('Z', '+00:00'))
        age = (now - when).total_seconds()
        if age < 0 or age > seconds or (label == 'restore' and evidence.get('status') != 'verified'):
            alerts.append(label + '_stale_or_unverified')
    except (OSError, ValueError, KeyError, TypeError):
        alerts.append(label + '_evidence_missing')
print(json.dumps({'alerts': alerts}))
raise SystemExit(bool(alerts))
