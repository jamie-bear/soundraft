This document outlines the architecture, data design, and implementation specifications for the audio collaboration platform.

### 1. High-Level System Architecture

The application follows a **standard 3-tier architecture**, containerized for portability.

**Components:**

1. **Frontend (Client):** Single Page Application (SPA) built with **React** (Vite).
   * *Rationale:* SPAs provide the seamless, uninterrupted audio playback required while navigating between views. Server-side rendering (SSR) causes audio dropouts during page navigation.
2. **Backend (API):** **Node.js** with **Express** (or NestJS).
   * *Rationale:* Excellent handling of I/O-bound tasks (streaming audio), huge ecosystem for audio processing libraries (fluent-ffmpeg), and shared language (TypeScript) with frontend.
3. **Database:** **PostgreSQL**.
   * *Rationale:* Relational integrity is strictly required for the complex relationships between Playlists, Tracks, Versions, and Users.
4. **File Storage:** **MinIO** (S3-compatible Object Storage).
   * *Rationale:* Abstraction layer. In development/local Docker, MinIO saves to a local volume. In production, the client library is simply repointed to AWS S3 or DigitalOcean Spaces without code changes.


---

### 2. Core Data Models (Schema Design)

The database schema uses normalized tables. `UUIDs` are recommended for IDs to obfuscate sequential data usage.

#### A. Users

| **Field** | **Type** | **Notes** |
|----|----|----|
| `id` | UUID | PK |
| `email` | String | Unique, Indexed |
| `password_hash` | String | Bcrypt/Argon2 |
| `role` | Enum | `USER`, `ADMIN` |
| `created_at` | Timestamp |    |

#### B. Tracks (Parent Container)

| **Field** | **Type** | **Notes** |
|----|----|----|
| `id` | UUID | PK |
| `owner_id` | UUID | FK -> Users.id |
| `title` | String |    |
| `project_status` | Enum | `POC`, `DRAFT`, `WIP`, `FINAL` |
| `track_type` | Enum | `RELEASE`, `RADIO_MIX`, `ALT_MIX` |
| `cover_art_url` | String | Nullable |
| `latest_version_id` | UUID | FK -> TrackVersions.id (Optimization for quick playback) |
| `is_public` | Boolean | Default `False` |
| `share_token` | String | Unique token for public access |

#### C. TrackVersions (Audio Files)

| **Field** | **Type** | **Notes** |
|----|----|----|
| `id` | UUID | PK |
| `track_id` | UUID | FK -> Tracks.id |
| `version_number` | Integer | Auto-incremented per track context |
| `filename` | String | Original upload name |
| `storage_key` | String | MinIO/S3 Path |
| `duration_sec` | Integer |    |
| `file_size` | BigInt | Bytes |
| `mime_type` | String | `audio/mpeg` or `audio/wav` |
| `created_at` | Timestamp | Used for sorting |

#### D. Attachments (Owner Only)

| **Field** | **Type** | **Notes** |
|----|----|----|
| `id` | UUID | PK |
| `track_id` | UUID | FK -> Tracks.id |
| `filename` | String |    |
| `storage_key` | String |    |
| `file_size` | BigInt |    |
| `created_at` | Timestamp |    |

#### E. Playlists

| **Field** | **Type** | **Notes** |
|----|----|----|
| `id` | UUID | PK |
| `owner_id` | UUID | FK -> Users.id |
| `title` | String |    |
| `type` | Enum | `ALBUM`, `EP`, `SINGLE`, `PLAYLIST` |
| `share_config` | Enum | `PRIVATE`, `PUBLIC_VIEW`, `PUBLIC_COMMENT` |
| `share_token` | String | Unique token |

#### F. PlaylistTracks (Join Table)

| **Field** | **Type** | **Notes** |
|----|----|----|
| `playlist_id` | UUID | FK -> Playlists.id |
| `track_id` | UUID | FK -> Tracks.id |
| `sort_order` | Integer | 0-indexed position |

#### G. Comments

| **Field** | **Type** | **Notes** |
|----|----|----|
| `id` | UUID | PK |
| `entity_type` | Enum | `TRACK`, `PLAYLIST` |
| `entity_id` | UUID | ID of Track or Playlist |
| `user_id` | UUID | Nullable (if anonymous comments allowed) |
| `timestamp_sec` | Float | Nullable. Audio timestamp context |
| `body` | Text |    |


---

### 3. Key Logic & API Responsibilities

#### Audio Upload & Versioning Logic


1. **Endpoint:** `POST /api/tracks/:id/versions`
2. **Process:**
   * Multer middleware intercepts file.
   * Backend validates MIME type (`audio/wav`, `audio/mpeg`).
   * File uploaded to MinIO bucket `audio-files`.
   * `ffprobe` runs to extract duration.
   * Insert into `TrackVersions`.
   * Update parent `Tracks` table -> `latest_version_id` = new version ID.

#### Playback Logic (Range Requests)

* **Endpoint:** `GET /api/stream/:versionId`
* **Logic:** Standard HTTP file serving is insufficient for seeking. The controller must implement **HTTP Range Request** handling (Status 206 Partial Content). It reads the `Range` header from the browser request and streams only the requested byte chunk from MinIO to the client.

#### Playlist Duplication Logic

* **Action:** User clicks "Duplicate" on "Summer Vibes" (Playlist).
* **Logic:**

  
  1. Create new Playlist row: `title` = "Summer Vibes (Copy)".
  2. Select all rows from `PlaylistTracks` where `playlist_id` = original.
  3. Bulk insert these rows into `PlaylistTracks` with the new `playlist_id`.
  4. Tracks themselves are **not** duplicated (passed by reference).

#### Access Control Logic (Middleware)

Permissions are enforced via two middlewares:


1. `requireAuth`: Checks valid JWT in header.
2. `checkResourceAccess`:
   * **If Owner:** Allow all.
   * **If Attachment:** Deny unless Owner.
   * **If Shared Link:** Look up `share_token` in query/params.
     * If token matches Track/Playlist -> Set `req.accessLevel` = `READ` or `COMMENT`.
     * If `READ` level, block `POST/PUT/DELETE` methods.


---

### 4. UI / UX Flow Overview

#### A. Global Components

* **Persistent Audio Player:** Fixed at the bottom of the viewport. Maintains state (Context API/Zustand) across route changes. Contains Play/Pause, Seek Bar, Volume, and "Currently Playing" info.

#### B. Dashboard (Project List)

* **Grid/List View:** Cards representing Tracks and Playlists.
* **Status Indicators:** Color-coded badges (e.g., Orange for "Draft", Green for "Final").
* **Quick Actions:** Hover buttons for "Add to Playlist", "Share", "Edit".

#### C. Track Detail View


1. **Header:** Title, Version Dropdown (Defaults to Latest), Status Badge, Waveform Visualization (generated via `audiowaveform` JSON).
2. **Version History:** Sidebar or Modal showing previous versions with upload dates. Clicking one swaps the audio source.
3. **Attachments:** List view below header. Only visible to owner. Download buttons.
4. **Comments:** Right-hand rail or time-synced markers on the waveform.

#### D. Playlist Editor


1. **Drag-and-Drop:** React-Beautiful-DnD or Dnd-Kit.
2. **Track List:** Shows Track Title, Artist, Duration.
3. **Search/Add:** A side panel to search existing library tracks and drag them *into* the playlist.

#### E. The "Share" Experience

* **Modal:** "Share this Track".
* **Toggles:**
  * "Enable Public Link" (Switch).
  * "Allow Comments" (Switch).
* **Output:** Read-only Input field with `https://app.com/s/token-uuid` and a "Copy" button.


---

### 5. Deployment & Infrastructure (Docker Compose)

This configuration enables a complete local environment that mirrors production.

**Structure:**

* `/api` (Node)
* `/web` (React)
* `/db` (Postgres data)
* `/storage` (MinIO data)

`**docker-compose.yml**` **Specification:**

```javascript
version: '3.8'

services:
  # --- Frontend ---
  web:
    build: ./web
    ports:
      - "3000:3000"
    environment:
      - VITE_API_URL=http://localhost:8080/api
    depends_on:
      - api

  # --- Backend ---
  api:
    build: ./api
    ports:
      - "8080:8080"
    environment:
      - DATABASE_URL=postgresql://user:pass@db:5432/music_app
      - JWT_SECRET=${JWT_SECRET}
      - MINIO_ENDPOINT=minio
      - MINIO_ACCESS_KEY=minio_access
      - MINIO_SECRET_KEY=minio_secret
      - MINIO_BUCKET=audio-assets
      - ADMIN_EMAIL=${ADMIN_EMAIL}
      - ADMIN_PASSWORD=${ADMIN_PASSWORD}
    depends_on:
      - db
      - minio

  # --- Database ---
  db:
    image: postgres:15-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=pass
      - POSTGRES_DB=music_app

  # --- Object Storage (S3 Compatible) ---
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000" # API
      - "9001:9001" # Console
    environment:
      - MINIO_ROOT_USER=minio_access
      - MINIO_ROOT_PASSWORD=minio_secret
    volumes:
      - minio_data:/data

volumes:
  pgdata:
  minio_data:
```

### 6. Implementation Checklist for Developer


1. **Setup:** Initialize Repo (Monorepo recommended: Turborepo or Nx).
2. **Backend Core:** Setup Express, TypeORM/Prisma (ORM), and Passport/JWT.
3. **Storage:** Implement a generic `FileService` interface. Implement `MinioService` executing that interface.
4. **Audio Streaming:** Implement the `fs.createReadStream` logic with Range headers in the API controller.
5. **Frontend Player:** Create a `AudioPlayerContext` using the HTML5 Audio API (or Howler.js).
6. **Drag and Drop:** Implement `dnd-kit` for the playlist sorting view.
7. **Admin Seeding:** Ensure server startup checks for the existence of `ADMIN_EMAIL` in DB. If missing, create it using `.env` credentials.
