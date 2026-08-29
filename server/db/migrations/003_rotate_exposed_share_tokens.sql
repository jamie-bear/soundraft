-- Invalidate share URLs that may have been exposed with historical repository
-- artifacts. This migration intentionally runs once per database.
UPDATE tracks
SET share_token = replace(uuid_generate_v4()::text, '-', ''),
    updated_at = CURRENT_TIMESTAMP
WHERE share_token IS NOT NULL;

UPDATE playlists
SET share_token = replace(uuid_generate_v4()::text, '-', '')
WHERE share_token IS NOT NULL;
