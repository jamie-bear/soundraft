-- SoundRaft Database Schema
-- This file is automatically executed on first database initialization

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =====================================================
-- SYSTEM CONFIGURATION
-- =====================================================

-- System settings table (key-value store for app configuration)
CREATE TABLE system_settings (
    key VARCHAR(100) PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Seed default system settings
INSERT INTO system_settings (key, value) VALUES
    ('signups_enabled', 'true'),
    ('smtp_host', ''),
    ('smtp_port', '587'),
    ('smtp_user', ''),
    ('smtp_password', ''),
    ('smtp_from_email', ''),
    ('smtp_from_name', 'SoundRaft');

-- =====================================================
-- USERS & AUTHENTICATION
-- =====================================================

-- Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(50) DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN')),
    is_active BOOLEAN DEFAULT TRUE,
    last_login_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- User invitations table (for future email invites)
CREATE TABLE user_invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) NOT NULL,
    token VARCHAR(64) UNIQUE NOT NULL,
    invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    accepted_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- TRACKS & VERSIONS
-- =====================================================

-- Tracks Table
CREATE TABLE tracks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    status VARCHAR(50) DEFAULT 'WIP' CHECK (status IN ('POC', 'DRAFT', 'WIP', 'FINAL')),
    type VARCHAR(50) DEFAULT 'RELEASE' CHECK (type IN ('RELEASE', 'RADIO_MIX', 'ALT_MIX')),
    release_status VARCHAR(50) DEFAULT 'PRIVATE' CHECK (release_status IN ('PRIVATE', 'PUBLIC')),
    comment_access VARCHAR(50) DEFAULT 'PRIVATE' CHECK (comment_access IN ('PRIVATE', 'PUBLIC_VIEW', 'PUBLIC_FULL')),
    cover_art_path VARCHAR(255),
    current_version_id UUID,
    share_token VARCHAR(64) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Track Versions (The actual audio files)
CREATE TABLE track_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    version_number INTEGER NOT NULL,
    filename VARCHAR(255) NOT NULL,
    storage_key VARCHAR(255) NOT NULL,
    mime_type VARCHAR(100) NOT NULL,
    size_bytes BIGINT NOT NULL,
    duration_seconds INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Add Foreign Key for current_version_id (after track_versions exists)
ALTER TABLE tracks
ADD CONSTRAINT fk_current_version
FOREIGN KEY (current_version_id) REFERENCES track_versions(id);

-- =====================================================
-- ATTACHMENTS
-- =====================================================

-- Attachments (Owner Only - enforced in API middleware)
CREATE TABLE attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    storage_key VARCHAR(255) NOT NULL,
    size_bytes BIGINT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- =====================================================
-- PLAYLISTS
-- =====================================================

-- Playlists
CREATE TABLE playlists (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    type VARCHAR(50) DEFAULT 'PLAYLIST' CHECK (type IN ('ALBUM', 'EP', 'SINGLE', 'PLAYLIST')),
    cover_art_path VARCHAR(255),
    is_public BOOLEAN DEFAULT FALSE,
    comment_access VARCHAR(50) DEFAULT 'PRIVATE' CHECK (comment_access IN ('PRIVATE', 'PUBLIC_VIEW', 'PUBLIC_FULL')),
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

-- =====================================================
-- COMMENTS (Supports both Tracks and Playlists)
-- =====================================================

-- Comments
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
    body TEXT NOT NULL,
    audio_timestamp FLOAT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- Ensure comment belongs to either a track OR a playlist, not both
    CONSTRAINT comments_entity_check CHECK (
        (track_id IS NOT NULL AND playlist_id IS NULL) OR 
        (track_id IS NULL AND playlist_id IS NOT NULL)
    )
);

-- =====================================================
-- REACTIONS (Emoji reactions for tracks/playlists)
-- =====================================================

-- Reactions (visitor-based, one per visitor per entity)
CREATE TABLE reactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
    visitor_id VARCHAR(64) NOT NULL,  -- fingerprint/localStorage ID for anonymous visitors
    emoji_type VARCHAR(20) NOT NULL CHECK (emoji_type IN ('heart', 'fire', 'laugh', 'cry')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- Ensure reaction belongs to either a track OR a playlist, not both
    CONSTRAINT reactions_entity_check CHECK (
        (track_id IS NOT NULL AND playlist_id IS NULL) OR 
        (track_id IS NULL AND playlist_id IS NOT NULL)
    ),
    -- One reaction per visitor per entity
    CONSTRAINT reactions_unique_track UNIQUE (track_id, visitor_id),
    CONSTRAINT reactions_unique_playlist UNIQUE (playlist_id, visitor_id)
);

-- =====================================================
-- INDEXES
-- =====================================================

-- Users
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);

-- Tracks
CREATE INDEX idx_tracks_owner ON tracks(owner_id);
CREATE INDEX idx_tracks_share_token ON tracks(share_token);

-- Track Versions
CREATE INDEX idx_track_versions_track ON track_versions(track_id);

-- Attachments
CREATE INDEX idx_attachments_track ON attachments(track_id);
CREATE INDEX idx_attachments_sort ON attachments(track_id, sort_order);

-- Playlists
CREATE INDEX idx_playlists_owner ON playlists(owner_id);
CREATE INDEX idx_playlists_share_token ON playlists(share_token);

-- Playlist Tracks
CREATE INDEX idx_playlist_tracks_playlist ON playlist_tracks(playlist_id);

-- Comments
CREATE INDEX idx_comments_track ON comments(track_id);
CREATE INDEX idx_comments_playlist ON comments(playlist_id);
CREATE INDEX idx_comments_user ON comments(user_id);

-- Invitations
CREATE INDEX idx_invitations_token ON user_invitations(token);
CREATE INDEX idx_invitations_email ON user_invitations(email);

-- Reactions
CREATE INDEX idx_reactions_track ON reactions(track_id);
CREATE INDEX idx_reactions_playlist ON reactions(playlist_id);
CREATE INDEX idx_reactions_visitor ON reactions(visitor_id);
