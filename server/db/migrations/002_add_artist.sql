-- Add artist column to tracks and playlists
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS artist VARCHAR(255);
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS artist VARCHAR(255);
