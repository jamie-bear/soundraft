-- The application uses one configured bucket. Correct 004's legacy backfill
-- when upgrading an installation whose bucket is not named "tracks".
UPDATE storage_objects SET bucket = current_setting('soundraft.bucket')
WHERE bucket = 'tracks' AND current_setting('soundraft.bucket') <> 'tracks';
UPDATE object_deletion_outbox o SET bucket = s.bucket
FROM storage_objects s WHERE s.storage_key = o.storage_key;

CREATE OR REPLACE FUNCTION enqueue_storage_deletion(p_storage_key TEXT, p_bucket TEXT DEFAULT 'tracks')
RETURNS VOID AS $$
DECLARE object_bucket TEXT;
BEGIN
    IF p_storage_key IS NULL OR p_storage_key = '' THEN RETURN; END IF;
    -- Serialize activation and expiry. Recheck references AFTER obtaining the
    -- row lock, including ambiguous COMMIT outcomes from failed HTTP requests.
    SELECT bucket INTO object_bucket FROM storage_objects
    WHERE storage_key = p_storage_key FOR UPDATE;
    IF EXISTS (SELECT 1 FROM track_versions WHERE storage_key = p_storage_key)
       OR EXISTS (SELECT 1 FROM attachments WHERE storage_key = p_storage_key)
       OR EXISTS (SELECT 1 FROM tracks WHERE cover_art_path = '/api/storage/' || p_storage_key)
       OR EXISTS (SELECT 1 FROM playlists WHERE cover_art_path = '/api/storage/' || p_storage_key) THEN
        RETURN;
    END IF;
    INSERT INTO object_deletion_outbox (storage_key, bucket)
    VALUES (p_storage_key, COALESCE(object_bucket, NULLIF(p_bucket, ''), 'tracks'))
    ON CONFLICT (storage_key) DO UPDATE
    SET bucket = EXCLUDED.bucket, processed_at = NULL, locked_at = NULL,
        next_attempt_at = CURRENT_TIMESTAMP, last_error = NULL, updated_at = CURRENT_TIMESTAMP;
    UPDATE storage_objects SET state = 'DELETE_PENDING', updated_at = CURRENT_TIMESTAMP
    WHERE storage_key = p_storage_key;
END;
$$ LANGUAGE plpgsql;

-- Discard old erroneously queued deletions rather than deleting live media.
DELETE FROM object_deletion_outbox o WHERE EXISTS (
    SELECT 1 FROM track_versions WHERE storage_key = o.storage_key
    UNION ALL SELECT 1 FROM attachments WHERE storage_key = o.storage_key
    UNION ALL SELECT 1 FROM tracks WHERE cover_art_path = '/api/storage/' || o.storage_key
    UNION ALL SELECT 1 FROM playlists WHERE cover_art_path = '/api/storage/' || o.storage_key
);
UPDATE storage_objects s SET state = 'ACTIVE', updated_at = CURRENT_TIMESTAMP
WHERE state = 'DELETE_PENDING' AND NOT EXISTS (
    SELECT 1 FROM object_deletion_outbox o WHERE o.storage_key = s.storage_key
);
