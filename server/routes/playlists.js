const { logError } = require('../lib/logging');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sanitizeText } = require('../lib/text');
const { validateMetadata } = require('../lib/metadata');
const { prepareCover } = require('../lib/media');
const { evaluateResourceAccess, isUuid } = require('../lib/access');
const { addResourceUrls } = require('../lib/grants');
const { uploadDeadline } = require('../lib/uploads');
const { decodeCursor, pageLimit, pageResult } = require('../lib/pagination');
const { abandonStorageObject, activateStorageObject, stageStorageObject } = require('../lib/object-lifecycle');


const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads. Please wait a moment.' },
});

module.exports = function(pool, minioClient, BUCKET_NAME, uploads) {
    const router = require('../lib/router').createRouter();
        const coverUpload = uploads.cover || uploads;
    
    /**
     * GET /api/playlists
     * List all playlists for authenticated user
     * Optional query param: ?forTrack=trackId - includes whether each playlist contains the track
     */
    router.get('/', requireAuth, async (req, res) => {
        try {
            const q = require('../lib/library-query').libraryQuery(req.query, 'playlist', req.user.id);
            if (req.query.forTrack && !isUuid(req.query.forTrack)) return res.status(400).json({ error: 'Invalid track' });
            const result = await pool.query(`SELECT p.*,
                (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS track_count,
                EXISTS(SELECT 1 FROM playlist_tracks pt WHERE pt.playlist_id = p.id AND pt.track_id = $7::uuid) AS contains_track
                FROM playlists p WHERE ${q.where} ORDER BY ${q.order} LIMIT $6`, [...q.values, req.query.forTrack || null]);
            const page = q.page(result.rows);
            res.json({ playlists: page.items.map(addResourceUrls), next_cursor: page.next_cursor });
        } catch (err) {
            logError('List playlists error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to list playlists' });
        }
    });

    /**
     * POST /api/playlists
     * Create a new playlist
     */
    router.post('/', requireAuth, async (req, res) => {
        try {
            const { title, artist, type = 'PLAYLIST' } = req.body;
            const invalid = validateMetadata(req.body, 'playlist', true);
            if (invalid) return res.status(400).json({ error: invalid });

            const sanitizedTitle = sanitizeText(title);
            if (!sanitizedTitle) {
                return res.status(400).json({ error: 'Title is required' });
            }

            const shareToken = crypto.randomBytes(16).toString('hex');

            const result = await pool.query(`
                INSERT INTO playlists (owner_id, title, artist, type, share_token)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `, [req.user.id, sanitizedTitle, sanitizeText(artist), type, shareToken]);

            res.status(201).json({ playlist: addResourceUrls(result.rows[0]) });
        } catch (err) {
            logError('Create playlist error:', err);
            res.status(500).json({ error: 'Failed to create playlist' });
        }
    });

    /**
     * GET /api/playlists/:id
     * Get playlist with tracks
     * The :id can be either a UUID or a share_token
     */
    router.get('/:id', optionalAuth, async (req, res) => {
        let client;
        try {
            client = await pool.connect();
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const { id } = req.params;
            const { token } = req.query;

            let playlistResult = await client.query(
                `SELECT * FROM playlists WHERE ${isUuid(id) ? 'id' : 'share_token'} = $1`,
                [id]
            );

            // Older installations may have UUID-shaped share tokens. Preserve
            // indexed ID lookups, then fall back to the indexed token column.
            if (playlistResult.rows.length === 0 && isUuid(id)) {
                playlistResult = await client.query(
                    'SELECT * FROM playlists WHERE share_token = $1',
                    [id]
                );
            }

            if (playlistResult.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            const playlist = playlistResult.rows[0];

            const access = evaluateResourceAccess({
                resource: playlist,
                resourceType: 'playlist',
                identifier: id,
                queryToken: token,
                user: req.user,
            });

            if (!access.allowed) {
                return res.status(access.status).json({ error: 'Access denied' });
            }

            const limit = pageLimit(req.query.limit);
            const cursor = decodeCursor(req.query.cursor, ['sort_order', 'id', 'revision', 'playlist_id']);
            if (cursor && (String(cursor.revision) !== String(playlist.revision) || cursor.playlist_id !== playlist.id)) {
                return res.status(409).json({ error: 'Playlist changed; reload it before continuing' });
            }
            // Detect concurrent membership edits before accepting a continuation.
            const tracksResult = await client.query(`
                SELECT t.id, t.title, t.artist, t.status, t.type, t.cover_art_path,
                       t.current_version_id,
                       tv.duration_seconds,
                       pt.sort_order
                FROM playlist_tracks pt
                JOIN tracks t ON pt.track_id = t.id
                LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                WHERE pt.playlist_id = $1
                  AND ($2::int IS NULL OR (pt.sort_order, t.id) > ($2::int, $3::uuid))
                ORDER BY pt.sort_order ASC, t.id ASC LIMIT $4
            `, [playlist.id, cursor?.sort_order ?? null, cursor?.id ?? null, limit + 1]);
            const page = pageResult(tracksResult.rows, limit, row => ({ sort_order: row.sort_order, id: row.id,
                revision: playlist.revision, playlist_id: playlist.id }));

            if (!access.isOwner) {
                delete playlist.share_token;
            }

            res.json({ 
                playlist: addResourceUrls(playlist),
                tracks: page.items.map(addResourceUrls),
                next_cursor: page.next_cursor,
                isOwner: access.isOwner,
            });
        } catch (err) {
            logError('Get playlist error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to get playlist' });
        } finally {
            if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
        }
    });

    /**
     * PUT /api/playlists/:id
     * Update playlist metadata
     */
    router.put('/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { title, artist, type, is_public, comment_access } = req.body;
            const invalid = validateMetadata(req.body, 'playlist');
            if (invalid) return res.status(400).json({ error: invalid });

            // Verify ownership
            const existing = await pool.query(
                'SELECT owner_id FROM playlists WHERE id = $1',
                [id]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (existing.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const result = await pool.query(`
                UPDATE playlists
                SET title = COALESCE($1, title),
                    artist = CASE WHEN $7 THEN $2 ELSE artist END,
                    type = COALESCE($3, type),
                    is_public = COALESCE($4, is_public),
                    comment_access = COALESCE($5, comment_access)
                WHERE id = $6
                RETURNING *
            `, [title !== undefined ? sanitizeText(title) : null, sanitizeText(artist) || null, type, is_public, comment_access, id, artist !== undefined]);

            res.json({ playlist: addResourceUrls(result.rows[0]) });
        } catch (err) {
            logError('Update playlist error:', err);
            res.status(500).json({ error: 'Failed to update playlist' });
        }
    });

    /**
     * DELETE /api/playlists/:id
     * Delete playlist (not the tracks)
     */
    router.delete('/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            // Verify ownership
            const existing = await pool.query(
                'SELECT owner_id FROM playlists WHERE id = $1',
                [id]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (existing.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            await pool.query('DELETE FROM playlists WHERE id = $1', [id]);

            res.json({ success: true });
        } catch (err) {
            logError('Delete playlist error:', err);
            res.status(500).json({ error: 'Failed to delete playlist' });
        }
    });

    /**
     * POST /api/playlists/:id/tracks/batch
     * Add up to 100 owned tracks in one transaction.
     */
    router.post('/:id/tracks/batch', requireAuth, async (req, res) => {
        const { id } = req.params;
        const trackIds = req.body.trackIds;
        if (!Array.isArray(trackIds) || trackIds.length < 1 || trackIds.length > 100
            || new Set(trackIds).size !== trackIds.length || trackIds.some((value) => !isUuid(value))) {
            return res.status(400).json({ error: 'trackIds must contain 1-100 unique track IDs' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
            const playlist = await client.query('SELECT owner_id FROM playlists WHERE id = $1 FOR UPDATE', [id]);
            if (!playlist.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Playlist not found' });
            }
            if (playlist.rows[0].owner_id !== req.user.id) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Access denied' });
            }
            const inserted = await client.query(`
                WITH requested AS (
                    SELECT track_id, ordinal
                    FROM unnest($2::uuid[]) WITH ORDINALITY AS r(track_id, ordinal)
                ), owned AS (
                    SELECT r.track_id, r.ordinal
                    FROM requested r JOIN tracks t ON t.id = r.track_id
                    WHERE t.owner_id = $3
                ), base AS (
                    SELECT COALESCE(MAX(sort_order), -1) AS value
                    FROM playlist_tracks WHERE playlist_id = $1
                )
                INSERT INTO playlist_tracks (playlist_id, track_id, sort_order)
                SELECT $1, owned.track_id, base.value + owned.ordinal
                FROM owned CROSS JOIN base
                ON CONFLICT (playlist_id, track_id) DO NOTHING
                RETURNING track_id
            `, [id, trackIds, req.user.id]);
            const owned = await client.query('SELECT COUNT(*)::int AS count FROM tracks WHERE id = ANY($1::uuid[]) AND owner_id = $2', [trackIds, req.user.id]);
            if (owned.rows[0].count !== trackIds.length) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'All tracks must exist and belong to you' });
            }
            await client.query('COMMIT');
            res.status(201).json({ success: true, added: inserted.rowCount });
        } catch (error) {
            await client.query('ROLLBACK');
            logError('Batch add tracks error:', error);
            res.status(500).json({ error: 'Failed to add tracks' });
        } finally {
            client.release();
        }
    });

    /**
     * POST /api/playlists/:id/tracks
     * Add a track to playlist
     */
    router.post('/:id/tracks', requireAuth, async (req, res) => {
        const client = await pool.connect();
        try {
            const { id } = req.params;
            const { trackId } = req.body;

            if (!trackId) {
                return res.status(400).json({ error: 'trackId is required' });
            }

            // Verify playlist ownership
            await client.query('BEGIN');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
            const playlist = await client.query(
                'SELECT owner_id FROM playlists WHERE id = $1',
                [id]
            );

            if (playlist.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (playlist.rows[0].owner_id !== req.user.id) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'Access denied' });
            }

            // Verify track exists and user owns it
            const track = await client.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [trackId]
            );

            if (track.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                await client.query('ROLLBACK');
                return res.status(403).json({ error: 'You can only add your own tracks' });
            }

            await client.query(`
                INSERT INTO playlist_tracks (playlist_id, track_id, sort_order)
                SELECT $1, $2, COALESCE(MAX(sort_order), -1) + 1
                FROM playlist_tracks WHERE playlist_id = $1
                ON CONFLICT (playlist_id, track_id) DO NOTHING
            `, [id, trackId]);

            await client.query('COMMIT');
            res.status(201).json({ success: true });
        } catch (err) {
            await client.query('ROLLBACK');
            logError('Add track to playlist error:', err);
            res.status(500).json({ error: 'Failed to add track' });
        } finally {
            client.release();
        }
    });

    /**
     * DELETE /api/playlists/:id/tracks/:trackId
     * Remove a track from playlist
     */
    router.delete('/:id/tracks/:trackId', requireAuth, async (req, res) => {
        try {
            const { id, trackId } = req.params;

            // Verify playlist ownership
            const playlist = await pool.query(
                'SELECT owner_id FROM playlists WHERE id = $1',
                [id]
            );

            if (playlist.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (playlist.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            await pool.query(
                'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
                [id, trackId]
            );

            res.json({ success: true });
        } catch (err) {
            logError('Remove track from playlist error:', err);
            res.status(500).json({ error: 'Failed to remove track' });
        }
    });

    /**
     * PUT /api/playlists/:id/reorder
     * Reorder tracks in playlist
     */
    router.put('/:id/reorder', requireAuth, async (req, res) => {
        const { id } = req.params;
        const { trackIds } = req.body;

        if (!Array.isArray(trackIds) || new Set(trackIds).size !== trackIds.length || trackIds.some((value) => !isUuid(value))) {
            return res.status(400).json({ error: 'trackIds must be a unique array of track IDs' });
        }

        // Verify playlist ownership
        const playlist = await pool.query(
            'SELECT owner_id FROM playlists WHERE id = $1',
            [id]
        );

        if (playlist.rows.length === 0) {
            return res.status(404).json({ error: 'Playlist not found' });
        }

        if (playlist.rows[0].owner_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query('SET CONSTRAINTS playlist_tracks_order_unique DEFERRED');
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
            const current = await client.query('SELECT COUNT(*)::int AS count FROM playlist_tracks WHERE playlist_id = $1', [id]);
            if (current.rows[0].count !== trackIds.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'trackIds must contain every playlist track exactly once' });
            }
            const updated = await client.query(`
                UPDATE playlist_tracks pt
                SET sort_order = ordered.ordinal - 1
                FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(track_id, ordinal)
                WHERE pt.playlist_id = $1 AND pt.track_id = ordered.track_id
            `, [id, trackIds]);
            if (updated.rowCount !== trackIds.length) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: 'trackIds contains an unknown track' });
            }

            await client.query('COMMIT');
            res.json({ success: true });
        } catch (e) {
            await client.query('ROLLBACK');
            logError('Reorder error:', e);
            res.status(500).json({ error: 'Failed to reorder tracks' });
        } finally {
            client.release();
        }
    });

    /**
     * POST /api/playlists/:id/duplicate
     * Duplicate a playlist
     */
    router.post('/:id/duplicate', requireAuth, async (req, res) => {
        const client = await pool.connect();
        
        try {
            const { id } = req.params;

            // Get original playlist
            const original = await client.query(
                'SELECT * FROM playlists WHERE id = $1',
                [id]
            );

            if (original.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            // Only owner can duplicate
            if (original.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            await client.query('BEGIN');

            // Create new playlist
            const shareToken = crypto.randomBytes(16).toString('hex');
            const newPlaylist = await client.query(`
                INSERT INTO playlists (owner_id, title, type, share_token)
                VALUES ($1, $2, $3, $4)
                RETURNING *
            `, [req.user.id, `${original.rows[0].title} (Copy)`, original.rows[0].type, shareToken]);

            // Copy tracks
            await client.query(`
                INSERT INTO playlist_tracks (playlist_id, track_id, sort_order)
                SELECT $1, track_id, sort_order
                FROM playlist_tracks
                WHERE playlist_id = $2
            `, [newPlaylist.rows[0].id, id]);

            await client.query('COMMIT');

            res.status(201).json({ playlist: addResourceUrls(newPlaylist.rows[0]) });
        } catch (err) {
            await client.query('ROLLBACK');
            logError('Duplicate playlist error:', err);
            res.status(500).json({ error: 'Failed to duplicate playlist' });
        } finally {
            client.release();
        }
    });

    /**
     * POST /api/playlists/:id/cover
     * Upload cover art for a playlist
     * Requirements: Square aspect ratio, max 20MB upload, auto-compress if >6MB
     */
    router.post('/:id/cover', requireAuth, uploadLimiter, uploadDeadline(2 * 60 * 1000), coverUpload.single('cover'), async (req, res) => {
        let storageKey;
        try {
            const { id } = req.params;

            if (!req.file) {
                return res.status(400).json({ error: 'No image file provided' });
            }

            // Validate file size (20MB max)
            const MAX_SIZE = 20 * 1024 * 1024; // 20MB
            if (req.file.size > MAX_SIZE) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(400).json({ error: 'File size exceeds 20MB limit' });
            }

            // Validate MIME type
            const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
            if (!allowedTypes.includes(req.file.mimetype)) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(400).json({ error: 'Invalid file type. Only JPEG, PNG, WebP, and GIF allowed.' });
            }

            // Verify ownership
            const playlist = await pool.query(
                'SELECT owner_id, cover_art_path FROM playlists WHERE id = $1',
                [id]
            );

            if (playlist.rows.length === 0) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (playlist.rows[0].owner_id !== req.user.id) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(403).json({ error: 'Access denied' });
            }

            await prepareCover(req.file);
            // Generate storage key
            const fileExt = req.file.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : req.file.mimetype.split('/')[1];
            storageKey = `covers/playlists/${id}_${crypto.randomBytes(16).toString('hex')}.${fileExt}`;

            await stageStorageObject(pool, {
                storageKey, bucket: BUCKET_NAME, ownerId: req.user.id,
                sizeBytes: req.file.size, mimeType: req.file.mimetype,
            });

            // Upload to MinIO from disk
            await minioClient.fPutObject(
                BUCKET_NAME,
                storageKey,
                req.file.path,
                { 'Content-Type': req.file.mimetype }
            );

            // Generate the cover art URL path
            const coverArtPath = `/api/storage/${storageKey}`;

            const client = await pool.connect();
            let result;
            try {
                await client.query('BEGIN');
                result = await client.query(`
                    UPDATE playlists SET cover_art_path = $1 WHERE id = $2 AND owner_id = $3 RETURNING *
                `, [coverArtPath, id, req.user.id]);
                if (!result.rows.length) {
                    const error = new Error('Playlist no longer exists');
                    error.statusCode = 404;
                    throw error;
                }
                await activateStorageObject(client, storageKey, 'PLAYLIST_COVER', id);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

            res.json({ playlist: addResourceUrls(result.rows[0]) });
        } catch (err) {
            if (storageKey) await abandonStorageObject(pool, storageKey, BUCKET_NAME).catch(() => {});
            logError('Upload cover art error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to upload cover art' });
        } finally {
            if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        }
    });

    /**
     * DELETE /api/playlists/:id/cover
     * Remove cover art from a playlist
     */
    router.delete('/:id/cover', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            // Verify ownership
            const playlist = await pool.query(
                'SELECT owner_id, cover_art_path FROM playlists WHERE id = $1',
                [id]
            );

            if (playlist.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (playlist.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Update playlist
            const result = await pool.query(`
                UPDATE playlists 
                SET cover_art_path = NULL
                WHERE id = $1
                RETURNING *
            `, [id]);

            res.json({ playlist: addResourceUrls(result.rows[0]) });
        } catch (err) {
            logError('Delete cover art error:', err);
            res.status(500).json({ error: 'Failed to delete cover art' });
        }
    });

    /**
     * POST /api/playlists/:id/share
     * Generate or regenerate share token for playlist
     */
    router.post('/:id/share', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { makePublic } = req.body;

            // Verify ownership
            const existing = await pool.query(
                'SELECT owner_id FROM playlists WHERE id = $1',
                [id]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (existing.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Generate new share token
            const shareToken = crypto.randomBytes(16).toString('hex');
            
            const result = await pool.query(`
                UPDATE playlists 
                SET share_token = $1,
                    is_public = $2
                WHERE id = $3
                RETURNING share_token, is_public
            `, [shareToken, makePublic ? true : false, id]);

            res.json({ 
                shareToken: result.rows[0].share_token,
                isPublic: result.rows[0].is_public
            });
        } catch (err) {
            logError('Share playlist error:', err);
            res.status(500).json({ error: 'Failed to generate share link' });
        }
    });

    return router;
};
