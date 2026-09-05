<p align="center">
  <img src="public/soundraft-logo.svg" alt="SoundRaft" width="120" height="120">
</p>

<h1 align="center">SoundRaft</h1>

<p align="center">
  <strong>Self-hosted audio versioning and collaboration platform for musicians and producers.</strong>
</p>

<p align="center">
  Upload tracks, manage versions, organize playlists, and share work from your own server.
</p>

---

## Why SoundRaft?

- **Version control for audio** — Keep every mix iteration and instantly switch versions.
- **Playlists as albums** — Organize tracks into Albums, EPs, Singles, or Playlists.
- **Share links** — Publish tracks/playlists and control comment permissions.
- **Timestamped comments** — Attach feedback to an exact moment in audio.
- **Attachments** — Keep stems, DAW sessions, MIDI, and references next to each track.
- **Self-hosted** — Your files and metadata stay on your infrastructure.

## Quick Start (Production with Docker Compose)

```bash
git clone https://github.com/jamie-bear/soundraft.git
cd soundraft
cp .env.example .env
# Edit .env (at minimum: JWT_SECRET, ADMIN_PASSWORD, DB_PASSWORD, S3 keys)
docker compose up -d
```

Open `http://localhost:8080`.

## Deployment Philosophy

`docker compose` is the default deployment method. The stack is designed so:

1. **Configuration is clear** (`.env` is the only file most users edit).
2. **Persistence is explicit** (database + uploads live in readable host folders by default).
3. **Migration is easy** (move/copy the `./data` directory, update `.env`, restart).

## Configuration

Copy `.env.example` to `.env`. Important groups:

### Required secrets

```env
JWT_SECRET=<openssl rand -hex 32>
ADMIN_PASSWORD=<strong admin password>
DB_PASSWORD=<openssl rand -hex 16>
S3_ACCESS_KEY=<openssl rand -hex 16>
S3_SECRET_KEY=<openssl rand -hex 16>
```

Never commit `.env` or deployment archives. For a running deployment, rotate
all credentials together with:

```bash
./scripts/rotate-deployment-secrets.sh
```

The script stops the API, changes the password of the existing PostgreSQL role,
invalidates share links, rotates the JWT, administrator, and MinIO credentials,
then recreates the services. Back up the database and object-storage directory
before rotating a production system.

For a deployment that has not been started yet, rotate only the local `.env`
values with `node scripts/rotate-local-secrets.js`.

### Persistent storage paths (host bind mounts by default)

```env
PG_DATA_LOCATION=./data/postgres
UPLOADS_LOCATION=./data/storage
CADDY_DATA_LOCATION=./data/caddy/data
CADDY_CONFIG_LOCATION=./data/caddy/config
```

You can point these at external disks/NAS paths:

```env
PG_DATA_LOCATION=/mnt/media/soundraft/postgres
UPLOADS_LOCATION=/mnt/media/soundraft/storage
```

### Optional: Docker named volumes instead of host folders

```env
PG_DATA_LOCATION=pg_data
UPLOADS_LOCATION=minio_data
```

## Data layout on host

Default layout after first boot:

```text
soundraft/
├── .env
└── data/
    ├── postgres/   # PostgreSQL cluster data
    ├── storage/    # MinIO object data (tracks, covers, attachments)
    └── caddy/      # TLS certs/config when proxy profile is enabled
```

This is deliberate to simplify backups and relocation.

## Relocation / migration workflow

### Move deployment to a new server

1. Stop containers on old host: `docker compose down`
2. Copy project folder (including `.env` and `data/`) to new host.
3. Update any absolute paths in `.env` if needed.
4. Start on new host: `docker compose up -d`

## Consistent backup and restore

The database and object store form one logical dataset; do not back them up independently. The helper stops the API, records database counts and SHA-256 hashes of every referenced media object, creates a PostgreSQL custom-format dump, and archives the quiesced object store. Build the current API image first (`docker compose build api`). Run these Bash helpers from the repository root; restore preflight requires Python 3. Backups require database/storage services to be running and exclusive control of all writers for the duration of the backup.

The environment file is included only when encrypted with age. The database and media remain sensitive (including any secrets stored in application settings): keep backups access-restricted and encrypt off-host copies. A backup may take longer than before because media is read and hashed before storage is archived.

```bash
# Create a timestamped backup under ./backups/
./scripts/backup.sh

# Optionally include .env encrypted for an age recipient
BACKUP_AGE_RECIPIENT=age1... ./scripts/backup.sh

# Restore only into new, empty persistence directories
RESTORE_PG_DATA_LOCATION=/srv/soundraft-restored/postgres \
RESTORE_UPLOADS_LOCATION=/srv/soundraft-restored/storage \
./scripts/restore.sh ./backups/<timestamp>

# Exercise the complete restore in an isolated temporary Compose project
./scripts/restore-drill.sh ./backups/<timestamp>
```

Format-3 restores verify checksums, reject unsafe/overlapping paths and archive links, and compare restored counts and complete media hashes. They leave the API stopped. Use the exact `COMPOSE_FILE=... docker compose up -d api` command printed by the restore; its persistent override points to the restored directories. Keep that override for subsequent Compose operations. Never revert to the old mounts accidentally. The drill uses an isolated Compose project and retains its temporary data for inspection. Older backup formats remain usable for manual recovery, but are not accepted by the verified helper.

If encrypted secrets are present, set `RESTORE_AGE_IDENTITY` and `RESTORE_SECRETS_OUTPUT` explicitly to decrypt them. Use the original storage bucket/credentials and compatible PostgreSQL/MinIO image versions when restoring. Test a full restore drill before relying on a backup or deploying schema changes.

## Verification and follow-up plan

Run `npm test` and `npm run test:integration` from `server`, `npm run build` from `client`, and `python3 scripts/test_restore_validation.py` from the repository root. Integration tests create an isolated temporary PostgreSQL database by default. To use an existing PostgreSQL service, set `TEST_DATABASE_URL` to a **new, empty database named `soundraft_test`**; tests refuse nonempty databases. Object transport is simulated in this suite; a real MinIO/Compose restore drill remains a separate release check. CI runs the integration suite on PostgreSQL 15.

See [the remediation review and optimization plan](docs/reliability-review-2026-09-05.md) for findings, verification boundaries, and the proposed next work.

## Optional HTTPS with Caddy

1. Set `DOMAIN` in `.env`.
2. Run:

```bash
docker compose --profile proxy up -d
```

Caddy will automatically request and renew TLS certificates.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS |
| Backend | Node.js, Express |
| Database | PostgreSQL 15 |
| Object Storage | MinIO (S3-compatible) |
| Containerization | Docker Compose |
| Reverse Proxy | Caddy (optional) |

## License

See [LICENSE](LICENSE) for details.
