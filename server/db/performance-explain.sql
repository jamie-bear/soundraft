-- Run against a representative restored dataset after ANALYZE. These plans
-- should use the *_cursor indexes added by migration 004 and avoid large sorts.
ANALYZE tracks;
ANALYZE playlists;
ANALYZE track_versions;
ANALYZE attachments;
ANALYZE comments;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, created_at
FROM tracks
WHERE owner_id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
ORDER BY created_at DESC, id DESC
LIMIT 101;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title, created_at
FROM playlists
WHERE owner_id = (SELECT id FROM users ORDER BY created_at LIMIT 1)
ORDER BY created_at DESC, id DESC
LIMIT 101;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, version_number
FROM track_versions
WHERE track_id = (SELECT id FROM tracks ORDER BY created_at LIMIT 1)
ORDER BY version_number DESC, id DESC
LIMIT 101;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, sort_order, created_at
FROM attachments
WHERE track_id = (SELECT id FROM tracks ORDER BY created_at LIMIT 1)
ORDER BY sort_order, created_at DESC, id DESC
LIMIT 101;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, created_at
FROM comments
WHERE track_id = (SELECT id FROM tracks ORDER BY created_at LIMIT 1)
ORDER BY created_at, id
LIMIT 101;
