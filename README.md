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

### Database-only migration (SQL dump)

```bash
# Backup
mkdir -p backups
docker compose exec -T db pg_dump -U "$DB_USER" "$DB_NAME" > backups/soundraft.sql

# Restore
cat backups/soundraft.sql | docker compose exec -T db psql -U "$DB_USER" -d "$DB_NAME"
```

### File storage backup

```bash
# If using default host path bind mounts:
tar -czf backups/storage-$(date +%F).tar.gz data/storage

# If using named volume mode:
docker compose cp storage:/data ./backups/storage
```

## One-command backup / restore helpers

```bash
# Create timestamped backup under ./backups/
./scripts/backup.sh

# Restore from a backup folder
./scripts/restore.sh ./backups/<timestamp>
```

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
