<p align="center">
  <img src="public/soundraft-logo.svg" alt="SoundRaft" width="120" height="120">
</p>

<h1 align="center">SoundRaft</h1>

<p align="center">
  <strong>Self-hosted audio versioning and collaboration platform for musicians and producers.</strong>
</p>

<p align="center">
  Upload tracks, manage versions, organize playlists, share with collaborators — all from your own server.
</p>

---

## Why SoundRaft?

Bouncing mixes back and forth over email or cloud drives gets messy fast. SoundRaft gives you a dedicated space to organize your work-in-progress audio with proper version history, so you always know which mix is the latest and can go back to any previous version instantly.

- **Version control for audio** — Upload new mixes to a track and switch between versions with one click. The latest version always plays by default.
- **Playlists as albums** — Organize tracks into Albums, EPs, Singles, or Playlists with drag-and-drop ordering and cover art.
- **Share without friction** — Generate public links for tracks or playlists. Control whether viewers can also leave comments.
- **Timestamped comments** — Leave feedback pinned to a specific moment in the audio. Collaborators see exactly what you're talking about.
- **Reactions** — Quick emoji feedback (heart, fire, laugh, cry) for shared tracks and playlists.
- **Attachments** — Attach DAW projects, stems, MIDI files, or any reference material to a track. Only the track owner can see these.
- **Persistent player** — Audio keeps playing as you navigate between pages. No interruptions.
- **Admin panel** — Manage users, invitations, signups, and system settings from a built-in admin interface.
- **Self-hosted & private** — Your music stays on your hardware. No third-party accounts, no subscriptions.

## Quick Start

```bash
git clone https://github.com/jamie-bear/soundraft.git
cd soundraft
cp .env.example .env
# Edit .env — set JWT_SECRET, ADMIN_PASSWORD, and storage credentials
docker compose up -d
```

Open `http://localhost:8080` and log in with your admin credentials.

## Configuration

All configuration lives in a single `.env` file. Copy `.env.example` to get started:

```env
# Required
JWT_SECRET=           # openssl rand -hex 32
ADMIN_PASSWORD=       # Strong password for the initial admin account

# Database
DB_USER=soundraft
DB_PASSWORD=          # openssl rand -hex 16
DB_NAME=soundraft

# Object Storage (MinIO)
S3_ACCESS_KEY=        # openssl rand -hex 16
S3_SECRET_KEY=        # openssl rand -hex 16

# Storage Locations (host paths or leave empty for Docker named volumes)
PG_DATA_LOCATION=./data/db
UPLOADS_LOCATION=./data/storage

# Optional
PORT=8080
DOMAIN=your-domain.com   # Enables automatic HTTPS via Caddy
```

### Storage Paths

Both the database and file storage locations are configurable:

| Variable | Controls | Default |
|----------|----------|---------|
| `PG_DATA_LOCATION` | PostgreSQL data directory | Docker named volume `pg_data` |
| `UPLOADS_LOCATION` | MinIO object storage (audio, cover art, attachments) | Docker named volume `minio_data` |

Set these to absolute or relative host paths to use bind mounts instead of Docker volumes. This makes backups and migration straightforward:

```env
PG_DATA_LOCATION=/mnt/storage/soundraft/db
UPLOADS_LOCATION=/mnt/storage/soundraft/uploads
```

### HTTPS with Caddy

Enable the built-in Caddy reverse proxy for automatic HTTPS:

```bash
docker compose --profile proxy up -d
```

Set the `DOMAIN` variable in `.env` to your domain name. Caddy handles Let's Encrypt certificates automatically.

## Development

```bash
docker compose -f docker-compose.dev.yml up
```

This starts:
- Vite dev server with HMR on `http://localhost:2950`
- API server on `http://localhost:8080`
- PostgreSQL on `localhost:3486`
- MinIO Console on `http://localhost:9001`
- pgAdmin on `http://localhost:5050`

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS |
| Backend | Node.js, Express |
| Database | PostgreSQL 15 |
| Object Storage | MinIO (S3-compatible) |
| Audio | ffmpeg, Howler.js |
| Auth | JWT, bcrypt |
| Containerization | Docker Compose |
| CI/CD | GitHub Actions (multi-arch builds on GHCR) |

## Backup & Restore

```bash
# Database
docker compose exec db pg_dump -U $DB_USER $DB_NAME > backup.sql
docker compose exec -T db psql -U $DB_USER $DB_NAME < backup.sql

# File storage
docker compose cp storage:/data ./storage-backup
```

## License

See [LICENSE](LICENSE) for details.
