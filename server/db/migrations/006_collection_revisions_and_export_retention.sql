ALTER TABLE playlists ADD COLUMN revision BIGINT NOT NULL DEFAULT 0;
CREATE FUNCTION bump_playlist_revision() RETURNS TRIGGER AS $$
BEGIN
    -- Transition tables preserve one parent update per bulk statement, rather
    -- than turning a batch reorder into one update for every track.
    IF TG_OP = 'DELETE' THEN
        UPDATE playlists SET revision = revision + 1 WHERE id IN (SELECT playlist_id FROM old_rows);
    ELSIF TG_OP = 'UPDATE' THEN
        UPDATE playlists SET revision = revision + 1 WHERE id IN (
            SELECT playlist_id FROM old_rows UNION SELECT playlist_id FROM new_rows
        );
    ELSE
        UPDATE playlists SET revision = revision + 1 WHERE id IN (SELECT playlist_id FROM new_rows);
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER playlist_membership_insert_revision AFTER INSERT ON playlist_tracks
REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_playlist_revision();
CREATE TRIGGER playlist_membership_update_revision AFTER UPDATE ON playlist_tracks
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_playlist_revision();
CREATE TRIGGER playlist_membership_delete_revision AFTER DELETE ON playlist_tracks
REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION bump_playlist_revision();

CREATE INDEX tracks_owner_created_id_idx ON tracks(owner_id, created_at DESC, id DESC);
CREATE INDEX tracks_owner_title_id_idx ON tracks(owner_id, title, id);
CREATE INDEX playlists_owner_title_id_idx ON playlists(owner_id, title, id);
