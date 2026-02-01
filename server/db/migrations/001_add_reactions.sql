-- Migration: Add reactions table for emoji reactions on tracks/playlists
-- Run this on existing databases to add the reactions feature

-- Create reactions table if it doesn't exist
CREATE TABLE IF NOT EXISTS reactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    track_id UUID REFERENCES tracks(id) ON DELETE CASCADE,
    playlist_id UUID REFERENCES playlists(id) ON DELETE CASCADE,
    visitor_id VARCHAR(64) NOT NULL,
    emoji_type VARCHAR(20) NOT NULL CHECK (emoji_type IN ('heart', 'fire', 'laugh', 'cry')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT reactions_entity_check CHECK (
        (track_id IS NOT NULL AND playlist_id IS NULL) OR 
        (track_id IS NULL AND playlist_id IS NOT NULL)
    )
);

-- Add unique constraints if they don't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reactions_unique_track'
    ) THEN
        ALTER TABLE reactions ADD CONSTRAINT reactions_unique_track UNIQUE (track_id, visitor_id);
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'reactions_unique_playlist'
    ) THEN
        ALTER TABLE reactions ADD CONSTRAINT reactions_unique_playlist UNIQUE (playlist_id, visitor_id);
    END IF;
END $$;

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_reactions_track ON reactions(track_id);
CREATE INDEX IF NOT EXISTS idx_reactions_playlist ON reactions(playlist_id);
CREATE INDEX IF NOT EXISTS idx_reactions_visitor ON reactions(visitor_id);
