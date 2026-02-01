# Design and Feature Specifications

## Project Overview

Soundraft is a web application that allows **musicians and music producers** to upload, version, annotate, listen to, and share **work-in-progress audio tracks and playlists**.

The application should prioritize:
- Fast, simple uploads
- A clean and professional playback experience
- Clear organization of projects and versions
- Controlled sharing and collaboration

---

## Core Domain Concepts

### Users
- Registered users can own, upload, edit, and share content
- Permissions determine who can view, comment on, or edit shared content

---

### Tracks
A **Track** represents a musical work and contains:
- One or more **audio versions**
- Optional **cover art**
- Metadata (type, project status, release status)
- Owner-only attachments

Playback must **default to the most recent version**.

---

### Track Versions
- Nested within a parent Track
- Each version references exactly one uploaded audio file
- Supported audio formats:
  - `.wav`
  - `.mp3`

---

### Attachments (Track-Level)
- Arbitrary file uploads (e.g. DAW projects, MIDI, AAC, stems)
- Features:
  - Rename
  - Reorder
  - Download
- Visibility:
  - **Owner only**
- Attachments are associated with the **main Track**, not individual versions

---

### Playlists
A **Playlist** is an ordered collection of Tracks.

Supported features:
- Add and remove tracks
- Drag-and-drop reordering
- Cover art
- Duplication (e.g. `"Album Name (Copy)"`)

Playlist types:
- Album
- EP
- Single
- Playlist

---

## Metadata & Status Tags

Applicable to Tracks and Playlists where relevant:

### Type
- Tracks: Release, Radio Mix, Alternative Mix, etc.
- Playlists: Album, EP, Single, Playlist

### Project Status
- Proof of Concept
- Draft
- Work in Progress
- Final

### Release Status
- Private
- Public

---

## Comments & Annotations

- Supported at both **Track** and **Playlist** levels
- Configurable access per item:
  - **Private** — only owner can view/comment
  - **Public** — anyone with link can view comments
  - **Public Plus** — anyone with link can view and comment
- Comments should support timestamps or playback-position references where applicable

---

## Sharing & Access Control

- Generate shareable links for Tracks and Playlists
- Sharing rules:
  - Public playlists grant **read-only access** to included tracks
  - Only the **latest version** of each track is accessible via shared playlists
- Support:
  - Private links (logged-in users only)
  - Public links (anyone with the URL)

---

## UI / UX Requirements

- Minimalist, functional, professional design
- Emphasis on:
  - Quick upload and track creation
  - Intuitive playback controls
  - Clear version switching
- Features:
  - Drag-and-drop playlist ordering
  - Simple cover art upload

Supported image formats for cover art:
- `.jpeg`
- `.jpg`
- `.png`
- `.webp`

---

## User Management & Administration

- Basic user authentication system
- User database with role and permission support
- Admin panel for managing:
  - User permissions (view, edit, share)
- Initial admin credentials must be configurable via `.env`

---

## Deployment & Infrastructure

- Deployment via **Docker Compose**
- Describe:
  - Service separation (frontend, backend, database, storage)
  - Environment variable usage
  - File storage strategy (local filesystem vs object storage abstraction)

---

## Expected Deliverables

The AI should provide:

1. High-level system architecture
2. Core data models and relationships
3. Key API endpoints or service responsibilities
4. Permission and access-control logic
5. UI flow overview for primary user actions
6. Deployment considerations using Docker Compose
