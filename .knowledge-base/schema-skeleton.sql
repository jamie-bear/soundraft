-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Tracks Table
CREATE TABLE tracks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'WIP' CHECK (status IN ('POC', 'DRAFT', 'WIP', 'FINAL')),
    type VARCHAR(50) DEFAULT 'RELEASE' CHECK (type IN ('RELEASE', 'RADIO_MIX', 'ALT_MIX')),
    release_status VARCHAR(50) DEFAULT 'PRIVATE' CHECK (release_status IN ('PRIVATE', 'PUBLIC')),
    cover_art_path VARCHAR(255),
    -- Represents the "Active" version. Updated via trigger or app logic.
    current_version_id UUID,
    share_token VARCHAR(64) UNIQUE, -- For public link sharing
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Track Versions (The actual audio files)
CREATE TABLE track_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    filename VARCHAR(255) NOT NULL,
    storage_key VARCHAR(255) NOT NULL, -- Path in MinIO/S3
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add Foreign Key for current_version_id back to track_versions
-- (Done after table creation to avoid circular dependency)
ALTER TABLE tracks
ADD CONSTRAINT fk_current_version
FOREIGN KEY (current_version_id) REFERENCES track_versions(id);

-- Attachments (Owner Only)
CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    storage_key VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Playlists
CREATE TABLE playlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'PLAYLIST' CHECK (type IN ('ALBUM', 'EP', 'SINGLE', 'PLAYLIST')),
    cover_art_path VARCHAR(255),
    is_public BOOLEAN DEFAULT FALSE,
    share_token VARCHAR(64) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Playlist Tracks (Join Table with Order)
CREATE TABLE playlist_tracks (
    playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    added_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (playlist_id, track_id)
);

-- Comments
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Nullable for anon/deleted users
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE, -- Can be expanded to Playlists later
    body TEXT NOT NULL,
    audio_timestamp FLOAT, -- Seconds into the track, NULL if general comment
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
