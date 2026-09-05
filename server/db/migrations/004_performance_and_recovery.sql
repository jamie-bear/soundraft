-- Performance, ownership, session-state, and object-lifecycle invariants.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 1;

-- Normalize ordering/version values before adding uniqueness constraints.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY track_id
               ORDER BY version_number, created_at, id
           ) AS normalized_number
    FROM track_versions
    WHERE track_id IN (
        SELECT track_id FROM track_versions GROUP BY track_id
        HAVING COUNT(*) <> COUNT(DISTINCT version_number) OR MIN(version_number) <= 0
    )
)
UPDATE track_versions tv
SET version_number = ranked.normalized_number
FROM ranked
WHERE tv.id = ranked.id
  AND tv.version_number <> ranked.normalized_number;

WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY track_id
               ORDER BY sort_order, created_at, id
           ) - 1 AS normalized_order
    FROM attachments
)
UPDATE attachments a
SET sort_order = ranked.normalized_order
FROM ranked
WHERE a.id = ranked.id
  AND a.sort_order <> ranked.normalized_order;

WITH ranked AS (
    SELECT playlist_id, track_id,
           ROW_NUMBER() OVER (
               PARTITION BY playlist_id
               ORDER BY sort_order, added_at, track_id
           ) - 1 AS normalized_order
    FROM playlist_tracks
)
UPDATE playlist_tracks pt
SET sort_order = ranked.normalized_order
FROM ranked
WHERE pt.playlist_id = ranked.playlist_id
  AND pt.track_id = ranked.track_id
  AND pt.sort_order <> ranked.normalized_order;

-- Existing invalid current-version pointers are cleared rather than preventing
-- the service from starting after the stronger composite FK is introduced.
UPDATE tracks t
SET current_version_id = NULL
WHERE current_version_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM track_versions tv
      WHERE tv.id = t.current_version_id
        AND tv.track_id = t.id
  );

ALTER TABLE tracks ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE playlists ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE track_versions ALTER COLUMN track_id SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN track_id SET NOT NULL;
ALTER TABLE attachments ALTER COLUMN sort_order SET NOT NULL;

ALTER TABLE track_versions
    ADD CONSTRAINT track_versions_track_version_unique
    UNIQUE (track_id, version_number) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE track_versions
    ADD CONSTRAINT track_versions_track_id_id_unique UNIQUE (track_id, id);
ALTER TABLE track_versions
    ADD CONSTRAINT track_versions_storage_key_unique UNIQUE (storage_key);
ALTER TABLE track_versions
    ADD CONSTRAINT track_versions_size_nonnegative CHECK (size_bytes >= 0);
ALTER TABLE track_versions
    ADD CONSTRAINT track_versions_duration_nonnegative CHECK (duration_seconds >= 0);

ALTER TABLE attachments
    ADD CONSTRAINT attachments_track_order_unique
    UNIQUE (track_id, sort_order) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE attachments
    ADD CONSTRAINT attachments_storage_key_unique UNIQUE (storage_key);
ALTER TABLE attachments
    ADD CONSTRAINT attachments_size_nonnegative CHECK (size_bytes >= 0);
ALTER TABLE attachments
    ADD CONSTRAINT attachments_sort_nonnegative CHECK (sort_order >= 0);

ALTER TABLE playlist_tracks
    ADD CONSTRAINT playlist_tracks_order_unique
    UNIQUE (playlist_id, sort_order) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE playlist_tracks
    ADD CONSTRAINT playlist_tracks_sort_nonnegative CHECK (sort_order >= 0);

ALTER TABLE comments
    ADD CONSTRAINT comments_audio_timestamp_nonnegative
    CHECK (audio_timestamp IS NULL OR audio_timestamp >= 0);

ALTER TABLE tracks DROP CONSTRAINT IF EXISTS fk_current_version;
ALTER TABLE tracks
    ADD CONSTRAINT fk_current_version_ownership
    FOREIGN KEY (id, current_version_id)
    REFERENCES track_versions(track_id, id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE OR REPLACE FUNCTION enforce_playlist_track_ownership()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM playlists p
        JOIN tracks t ON t.id = NEW.track_id
        WHERE p.id = NEW.playlist_id
          AND p.owner_id = t.owner_id
    ) THEN
        RAISE EXCEPTION 'playlist and track must have the same owner';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS playlist_track_ownership_guard ON playlist_tracks;
CREATE TRIGGER playlist_track_ownership_guard
BEFORE INSERT OR UPDATE ON playlist_tracks
FOR EACH ROW EXECUTE FUNCTION enforce_playlist_track_ownership();

-- Lifecycle registry for staged uploads and an idempotent transactional
-- deletion outbox. Application rows remain the source of truth for ownership.
CREATE TABLE storage_objects (
    storage_key VARCHAR(512) PRIMARY KEY,
    bucket VARCHAR(255) NOT NULL,
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    resource_type VARCHAR(50),
    resource_id UUID,
    state VARCHAR(20) NOT NULL DEFAULT 'STAGED'
        CHECK (state IN ('STAGED', 'ACTIVE', 'DELETE_PENDING', 'DELETED')),
    size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
    mime_type VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    activated_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE object_deletion_outbox (
    id BIGSERIAL PRIMARY KEY,
    storage_key VARCHAR(512) NOT NULL UNIQUE,
    bucket VARCHAR(255) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    locked_at TIMESTAMP WITH TIME ZONE,
    last_error TEXT,
    processed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE OR REPLACE FUNCTION enqueue_storage_deletion(p_storage_key TEXT, p_bucket TEXT DEFAULT 'tracks')
RETURNS VOID AS $$
BEGIN
    IF p_storage_key IS NULL OR p_storage_key = '' THEN
        RETURN;
    END IF;

    INSERT INTO object_deletion_outbox (storage_key, bucket)
    VALUES (p_storage_key, COALESCE(NULLIF(p_bucket, ''), 'tracks'))
    ON CONFLICT (storage_key) DO UPDATE
    SET processed_at = NULL,
        locked_at = NULL,
        next_attempt_at = CURRENT_TIMESTAMP,
        last_error = NULL,
        updated_at = CURRENT_TIMESTAMP;

    UPDATE storage_objects
    SET state = 'DELETE_PENDING', updated_at = CURRENT_TIMESTAMP
    WHERE storage_key = p_storage_key;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_deleted_storage_key()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM track_versions WHERE storage_key = OLD.storage_key)
       AND NOT EXISTS (SELECT 1 FROM attachments WHERE storage_key = OLD.storage_key)
       AND NOT EXISTS (SELECT 1 FROM tracks WHERE regexp_replace(cover_art_path, '^.*/api/storage/', '') = OLD.storage_key)
       AND NOT EXISTS (SELECT 1 FROM playlists WHERE regexp_replace(cover_art_path, '^.*/api/storage/', '') = OLD.storage_key) THEN
        PERFORM enqueue_storage_deletion(OLD.storage_key);
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enqueue_replaced_cover()
RETURNS TRIGGER AS $$
DECLARE
    old_key TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.cover_art_path IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM tracks WHERE cover_art_path = OLD.cover_art_path)
           AND NOT EXISTS (SELECT 1 FROM playlists WHERE cover_art_path = OLD.cover_art_path) THEN
            old_key := regexp_replace(OLD.cover_art_path, '^.*/api/storage/', '');
            PERFORM enqueue_storage_deletion(old_key);
        END IF;
        RETURN OLD;
    END IF;

    IF OLD.cover_art_path IS NOT NULL
       AND OLD.cover_art_path IS DISTINCT FROM NEW.cover_art_path
       AND NOT EXISTS (SELECT 1 FROM tracks WHERE cover_art_path = OLD.cover_art_path)
       AND NOT EXISTS (SELECT 1 FROM playlists WHERE cover_art_path = OLD.cover_art_path) THEN
        old_key := regexp_replace(OLD.cover_art_path, '^.*/api/storage/', '');
        PERFORM enqueue_storage_deletion(old_key);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_unique_cover_path()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.cover_art_path IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext(NEW.cover_art_path));
    IF EXISTS (
        SELECT 1 FROM tracks
        WHERE cover_art_path = NEW.cover_art_path
          AND (TG_TABLE_NAME <> 'tracks' OR id <> NEW.id)
    ) OR EXISTS (
        SELECT 1 FROM playlists
        WHERE cover_art_path = NEW.cover_art_path
          AND (TG_TABLE_NAME <> 'playlists' OR id <> NEW.id)
    ) THEN
        RAISE EXCEPTION 'cover storage path is already assigned';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS track_version_storage_delete ON track_versions;
CREATE TRIGGER track_version_storage_delete
AFTER DELETE ON track_versions
FOR EACH ROW EXECUTE FUNCTION enqueue_deleted_storage_key();

DROP TRIGGER IF EXISTS attachment_storage_delete ON attachments;
CREATE TRIGGER attachment_storage_delete
AFTER DELETE ON attachments
FOR EACH ROW EXECUTE FUNCTION enqueue_deleted_storage_key();

DROP TRIGGER IF EXISTS track_cover_storage_replace ON tracks;
CREATE TRIGGER track_cover_storage_replace
AFTER UPDATE OF cover_art_path OR DELETE ON tracks
FOR EACH ROW EXECUTE FUNCTION enqueue_replaced_cover();

DROP TRIGGER IF EXISTS playlist_cover_storage_replace ON playlists;
CREATE TRIGGER playlist_cover_storage_replace
AFTER UPDATE OF cover_art_path OR DELETE ON playlists
FOR EACH ROW EXECUTE FUNCTION enqueue_replaced_cover();

DROP TRIGGER IF EXISTS track_cover_storage_unique ON tracks;
CREATE TRIGGER track_cover_storage_unique
BEFORE INSERT OR UPDATE OF cover_art_path ON tracks
FOR EACH ROW EXECUTE FUNCTION enforce_unique_cover_path();

DROP TRIGGER IF EXISTS playlist_cover_storage_unique ON playlists;
CREATE TRIGGER playlist_cover_storage_unique
BEFORE INSERT OR UPDATE OF cover_art_path ON playlists
FOR EACH ROW EXECUTE FUNCTION enforce_unique_cover_path();

-- Backfill the registry for existing row-backed objects. Cover sizes are
-- unknown until first reconciliation/stat and therefore begin at zero.
INSERT INTO storage_objects (
    storage_key, bucket, owner_id, resource_type, resource_id,
    state, size_bytes, mime_type, activated_at
)
SELECT tv.storage_key, 'tracks', t.owner_id, 'TRACK_VERSION', tv.id,
       'ACTIVE', tv.size_bytes, tv.mime_type, tv.created_at
FROM track_versions tv
JOIN tracks t ON t.id = tv.track_id
ON CONFLICT (storage_key) DO NOTHING;

INSERT INTO storage_objects (
    storage_key, bucket, owner_id, resource_type, resource_id,
    state, size_bytes, activated_at
)
SELECT a.storage_key, 'tracks', t.owner_id, 'ATTACHMENT', a.id,
       'ACTIVE', a.size_bytes, a.created_at
FROM attachments a
JOIN tracks t ON t.id = a.track_id
ON CONFLICT (storage_key) DO NOTHING;

INSERT INTO storage_objects (storage_key, bucket, owner_id, resource_type, resource_id, state, activated_at)
SELECT regexp_replace(t.cover_art_path, '^.*/api/storage/', ''),
       'tracks', t.owner_id, 'TRACK_COVER', t.id, 'ACTIVE', t.updated_at
FROM tracks t
WHERE t.cover_art_path IS NOT NULL
ON CONFLICT (storage_key) DO NOTHING;

INSERT INTO storage_objects (storage_key, bucket, owner_id, resource_type, resource_id, state, activated_at)
SELECT regexp_replace(p.cover_art_path, '^.*/api/storage/', ''),
       'tracks', p.owner_id, 'PLAYLIST_COVER', p.id, 'ACTIVE', p.created_at
FROM playlists p
WHERE p.cover_art_path IS NOT NULL
ON CONFLICT (storage_key) DO NOTHING;

-- Composite indexes match the keyset-pagination predicates used by routes.
CREATE INDEX idx_tracks_owner_updated_cursor
    ON tracks(owner_id, updated_at DESC, id DESC);
CREATE INDEX idx_tracks_owner_title_cursor
    ON tracks(owner_id, title ASC, id ASC);
CREATE INDEX idx_playlists_owner_created_cursor
    ON playlists(owner_id, created_at DESC, id DESC);
CREATE INDEX idx_playlists_owner_title_cursor
    ON playlists(owner_id, title ASC, id ASC);
CREATE INDEX idx_track_versions_track_version_cursor
    ON track_versions(track_id, version_number DESC, id DESC);
CREATE INDEX idx_attachments_track_sort_cursor
    ON attachments(track_id, sort_order ASC, created_at DESC, id DESC);
CREATE INDEX idx_comments_track_created_cursor
    ON comments(track_id, created_at ASC, id ASC);
CREATE INDEX idx_comments_playlist_created_cursor
    ON comments(playlist_id, created_at ASC, id ASC);
CREATE INDEX idx_storage_objects_owner_state
    ON storage_objects(owner_id, state);
CREATE INDEX idx_storage_objects_staged
    ON storage_objects(created_at) WHERE state = 'STAGED';
CREATE INDEX idx_deletion_outbox_ready
    ON object_deletion_outbox(next_attempt_at, id)
    WHERE processed_at IS NULL;
