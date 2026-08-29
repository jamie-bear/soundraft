# SoundRaft - Architecture Overview

## System Architecture

SoundRaft follows a standard 3-tier architecture, fully containerized with Docker Compose.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐     ┌─────────────┐
│  React SPA  │────▶│  Express API │────▶│ PostgreSQL  │     │    MinIO     │
│  (Vite)     │     │  (Node.js)   │────▶│   15-alpine │     │  (S3-compat)│
└─────────────┘     └──────────────┘     └─────────────┘     └─────────────┘
     Port 8080            :8080               :5432              :9000/:9001
   (served by API)     (backend)           (internal)           (internal)
```

In production the React SPA is built and served as static files by the Express API on a single port. An optional Caddy reverse proxy can be enabled for automatic HTTPS.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, Vite, TypeScript, Tailwind CSS |
| State Management | Zustand |
| Audio Playback | Howler.js (HTML5 Audio with range request support) |
| Drag & Drop | @dnd-kit |
| Backend | Node.js 18, Express |
| Database | PostgreSQL 15 |
| Object Storage | MinIO (S3-compatible) |
| Audio Metadata | music-metadata |
| Auth | JWT + bcrypt |
| Security | Helmet, CORS, rate limiting |
| Containerization | Docker Compose |
| Reverse Proxy | Caddy (optional, automatic HTTPS) |
| CI/CD | GitHub Actions (multi-arch Docker builds, GHCR) |

## Data Model

### Entity Relationships

- **User** 1:N **Tracks**
- **User** 1:N **Playlists**
- **Track** 1:N **TrackVersions** (audio files)
- **Track** 1:N **Attachments** (owner-only files: DAW projects, stems, etc.)
- **Playlist** N:M **Tracks** (via PlaylistTracks join table with sort order)
- **Track/Playlist** 1:N **Comments** (with optional audio timestamps)
- **Track/Playlist** 1:N **Reactions** (emoji reactions from visitors)

### Core Tables

| Table | Purpose |
|-------|---------|
| `users` | Authentication, roles (USER/ADMIN), invitation tracking |
| `user_invitations` | Email-based invitation system with expiring tokens |
| `tracks` | Parent container for audio projects with status/type metadata |
| `track_versions` | Individual audio file versions with duration, size, storage key |
| `attachments` | Owner-only file attachments per track |
| `playlists` | Ordered collections with type (Album/EP/Single/Playlist) |
| `playlist_tracks` | Join table with `sort_order` for drag-and-drop ordering |
| `comments` | Threaded comments on tracks or playlists with audio timestamps |
| `reactions` | Emoji reactions (heart/fire/laugh/cry) via visitor fingerprinting |
| `system_settings` | Key-value configuration (signups, SMTP, etc.) |

## Key Flows

### Audio Upload & Versioning
1. File uploaded via multer (500 MB limit)
2. MIME type validated (wav, mp3)
3. Stored in MinIO bucket
4. Duration extracted via ffprobe
5. New `TrackVersion` record created, parent track's `current_version_id` updated

### Audio Streaming
- HTTP Range Request support (206 Partial Content) for seeking
- Backend proxies byte ranges from MinIO to the client

### Playlist Ordering
- Drag-and-drop in the UI sends new ID order
- Backend updates `sort_order` in a transaction

### Access Control
- **Owner**: Full access to all resources
- **Attachments**: Owner-only (never public)
- **Share tokens**: Unique per-resource tokens for public/semi-public access
- **Comment access levels**: PRIVATE, PUBLIC_VIEW, PUBLIC_FULL

## Deployment

All services run via Docker Compose. Storage locations are configurable via `.env`:

```env
PG_DATA_LOCATION=./data/db          # PostgreSQL data
UPLOADS_LOCATION=./data/storage      # MinIO object storage
```

Leave unset to use Docker named volumes instead.

### Services
- **api** - Express backend serving the React SPA (port 8080)
- **db** - PostgreSQL 15 Alpine
- **storage** - MinIO S3-compatible object storage
- **caddy** (optional) - Reverse proxy with automatic HTTPS

Enable the Caddy proxy with: `docker compose --profile proxy up -d`

## Project Structure

```
soundraft/
├── client/              # React frontend (Vite + TypeScript)
│   ├── src/
│   │   ├── components/  # Reusable UI components
│   │   ├── pages/       # Route pages
│   │   ├── stores/      # Zustand state stores
│   │   └── lib/         # API client utilities
│   └── public/          # Static assets (logo, PWA manifest)
├── server/              # Express backend
│   ├── routes/          # API route handlers
│   ├── middleware/       # Auth & admin middleware
│   ├── db/              # Schema init & migrations
│   └── seed-data/       # Example content for first run
├── doc/                 # Project documentation
├── public/              # Repository-level assets (logo)
├── docker-compose.yml   # Production stack
├── docker-compose.dev.yml # Development stack (HMR, pgAdmin)
├── Caddyfile            # Reverse proxy config
└── Dockerfile           # (in server/) Multi-stage production build
```
