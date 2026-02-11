# Audio Collaboration Platform - Architecture Specification

## 1. Executive Summary

This document outlines the technical specifications for a web application designed for musicians and producers. The system facilitates the upload, version control, annotation, and sharing of work-in-progress audio tracks.

## 2. Technology Stack

* **Frontend:** React (Vite) + Tailwind CSS
  * *State Management:* Zustand (for global player state)
  * *Audio:* HTML5 Audio API / Howler.js
* **Backend:** Node.js (Express)
  * *ORM:* Prisma or TypeORM
  * *Audio Processing:* fluent-ffmpeg
* **Database:** PostgreSQL 15
* **Storage:** MinIO (S3-compatible object storage)
* **Containerization:** Docker & Docker Compose

## 3. Data Architecture

### Entity-Relationship Overview

* **User** `1:N` **Tracks**
* **Track** `1:N` **TrackVersions**
* **Track** `1:N` **Attachments** (Owner only visibility)
* **Playlist** `1:N` **PlaylistTracks** (Join table with order index)
* **User** `1:N` **Comments**
* **Track/Playlist** `1:N` **Comments** (Polymorphic association or separate tables)

### Critical Schemas

**Tracks Table**

* `id` (UUID)
* `owner_id` (FK)
* `current_version_id` (FK - Caches the active version for playback)
* `status` (Enum: POC, Draft, WIP, Final)
* `is_public` (Boolean)
* `share_token` (String - high entropy for sharing)

**TrackVersions Table**

* `id` (UUID)
* `track_id` (FK)
* `storage_path` (String)
* `version_number` (Int)
* `duration` (Int - seconds)

## 4. Key Logic Flows

### A. Audio Streaming (Range Requests)

To support seeking in the audio player, the backend **must not** simply send the file. It must implement partial content delivery:


1. Parse `Range` header from client (e.g., `bytes=0-`).
2. Calculate start and end bytes.
3. Stream specifically that chunk from MinIO/Storage.
4. Return HTTP 206 (Partial Content).

### B. Playlist Ordering

Ordering is managed via a `sort_order` integer in the `PlaylistTracks` join table.

* **Drag & Drop:** When a user reorders the UI, the frontend sends the new array of IDs.
* **Backend:** Updates the `sort_order` for the affected relationships in a transaction.

### C. Versioning

* New uploads to an existing Track create a new `TrackVersion` record.
* The parent `Track.current_version_id` is automatically updated to this new record.
* Old versions remain accessible via history but are not played by default.

### D. Security & Permissions

* **Attachments:** Middleware checks `req.user.id === track.owner_id`. If false, return 403 Forbidden. Attachments are never public.
* **Public Links:** Access is granted via a unique token in the URL (e.g., `/s/xyz-123`). This token bypasses authentication middleware for GET requests only (READ access).

## 5. Deployment Strategy

The application is deployed as a cluster of services defined in `docker-compose.yml`.


1. **Reverse Proxy (Optional but recommended):** Nginx to route `/api` requests to the backend and `/` to the frontend static files.
2. **Persistence:** Docker Volumes mapping:
   * `./storage_data:/data` (MinIO persistence)
   * `./db_data:/var/lib/postgresql/data` (Postgres persistence)
3. **Environment Variables:**
   * `JWT_SECRET`: Critical for auth security.
   * `ADMIN_INITIAL_PASS`: For seeding the first admin.
   * `S3_ENDPOINT`: URLs for file retrieval.

## 6. UI/UX Hierarchy


1. **Global Player:** Fixed footer. Persists across navigation.
2. **Project Dashboard:** Grid view of Tracks/Playlists.
3. **Track Detail:**
   * Large Play button.
   * Waveform visualizer.
   * Version selector dropdown.
   * Tabbed interface: Comments | Attachments (if owner).
4. **Playlist Detail:**
   * List of tracks.
   * Drag handle on the left of each row.