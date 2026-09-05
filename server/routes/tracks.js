const { logError } = require('../lib/logging');
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sanitizeText } = require('../lib/text');
const { validateMetadata } = require('../lib/metadata');
const { mutateVersion } = require('../lib/versions');
const { prepareCover, audioDuration } = require('../lib/media');
const { evaluateResourceAccess, isUuid } = require('../lib/access');
const { addResourceUrls, issueGrant, readGrant, streamUrl } = require('../lib/grants');
const { uploadDeadline } = require('../lib/uploads');
const { sendObject, streamFailure } = require('../lib/streaming');
const { decodeCursor, pageLimit, pageResult } = require('../lib/pagination');
const { abandonStorageObject, activateStorageObject, stageStorageObject } = require('../lib/object-lifecycle');


// Rate limiter for upload endpoints — 10/minute per IP
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads. Please wait a moment.' },
});

module.exports = function(pool, minioClient, BUCKET_NAME, uploads) {
    const router = require('../lib/router').createRouter();
        const audioUpload = uploads.audio || uploads;
    const coverUpload = uploads.cover || uploads;
    
    /**
     * GET /api/tracks
     * List all tracks for authenticated user
     */
    router.get('/', requireAuth, async (req, res) => {
        try {
            const q = require('../lib/library-query').libraryQuery(req.query, 'track', req.user.id);
            const result = await pool.query(`SELECT t.*, tv.duration_seconds,
                tv.version_number AS current_version_number
                FROM tracks t LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                WHERE ${q.where} ORDER BY ${q.order} LIMIT $6`, q.values);
            const page = q.page(result.rows);
            res.json({ tracks: page.items.map(addResourceUrls), next_cursor: page.next_cursor });
        } catch (err) {
            logError('List tracks error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to list tracks' });
        }
    });

    /**
     * POST /api/tracks
     * Create a new track
     */
    router.post('/', requireAuth, async (req, res) => {
        try {
            const { title, artist, status = 'WIP', type = 'RELEASE' } = req.body;
            const invalid = validateMetadata(req.body, 'track', true);
            if (invalid) return res.status(400).json({ error: invalid });

            const sanitizedTitle = sanitizeText(title);
            if (!sanitizedTitle) {
                return res.status(400).json({ error: 'Title is required' });
            }

            // Generate share token
            const shareToken = crypto.randomBytes(16).toString('hex');

            const result = await pool.query(`
                INSERT INTO tracks (owner_id, title, artist, status, type, share_token)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
            `, [req.user.id, sanitizedTitle, sanitizeText(artist), status, type, shareToken]);

            res.status(201).json({ track: addResourceUrls(result.rows[0]) });
        } catch (err) {
            logError('Create track error:', err);
            res.status(500).json({ error: 'Failed to create track' });
        }
    });

    /**
     * GET /api/tracks/:id
     * Get track details (with share token support)
     * The :id can be either a UUID or a share_token
     */
    router.get('/:id', optionalAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { token } = req.query;

            const trackQuery = `
                SELECT t.*,
                       tv.duration_seconds,
                       tv.version_number as current_version_number,
                       tv.filename as current_filename
                FROM tracks t
                LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                WHERE %COLUMN% = $1
            `;
            let result = await pool.query(
                trackQuery.replace('%COLUMN%', isUuid(id) ? 't.id' : 't.share_token'),
                [id]
            );

            // Older installations may have UUID-shaped share tokens. Preserve
            // indexed ID lookups, then fall back to the indexed token column.
            if (result.rows.length === 0 && isUuid(id)) {
                result = await pool.query(
                    trackQuery.replace('%COLUMN%', 't.share_token'),
                    [id]
                );
            }

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            const track = result.rows[0];

            const access = evaluateResourceAccess({
                resource: track,
                resourceType: 'track',
                identifier: id,
                queryToken: token,
                user: req.user,
            });

            if (!access.allowed) {
                return res.status(access.status).json({ error: 'Access denied' });
            }

            // Remove sensitive fields for non-owners
            if (!access.isOwner) {
                delete track.share_token;
            }

            res.json({ track: addResourceUrls(track), isOwner: access.isOwner });
        } catch (err) {
            logError('Get track error:', err);
            res.status(500).json({ error: 'Failed to get track' });
        }
    });

    /**
     * PUT /api/tracks/:id
     * Update track metadata
     */
    router.put('/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { title, artist, status, type, release_status, comment_access } = req.body;
            const invalid = validateMetadata(req.body, 'track');
            if (invalid) return res.status(400).json({ error: invalid });

            // Verify ownership
            const existing = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [id]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (existing.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const result = await pool.query(`
                UPDATE tracks
                SET title = COALESCE($1, title),
                    artist = CASE WHEN $8 THEN $2 ELSE artist END,
                    status = COALESCE($3, status),
                    type = COALESCE($4, type),
                    release_status = COALESCE($5, release_status),
                    comment_access = COALESCE($6, comment_access),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $7
                RETURNING *
            `, [title !== undefined ? sanitizeText(title) : null, sanitizeText(artist) || null, status, type, release_status, comment_access, id, artist !== undefined]);

            res.json({ track: addResourceUrls(result.rows[0]) });
        } catch (err) {
            logError('Update track error:', err);
            res.status(500).json({ error: 'Failed to update track' });
        }
    });

    /**
     * DELETE /api/tracks/:id
     * Delete track and all versions
     */
    router.delete('/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            // Verify ownership
            const existing = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [id]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (existing.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Database triggers enqueue object deletion transactionally.
            await pool.query('DELETE FROM tracks WHERE id = $1', [id]);

            res.json({ success: true });
        } catch (err) {
            logError('Delete track error:', err);
            res.status(500).json({ error: 'Failed to delete track' });
        }
    });

    /**
     * GET /api/tracks/:id/versions
     * List all versions of a track
     */
    router.get('/:id/versions', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const limit = pageLimit(req.query.limit);
            const cursor = decodeCursor(req.query.cursor, ['version_number', 'id']);

            // Verify ownership
            const track = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [id]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            const result = await pool.query(`
                SELECT id, version_number, filename, mime_type, size_bytes, duration_seconds, created_at
                FROM track_versions
                WHERE track_id = $1
                  AND ($2::int IS NULL OR (version_number, id) < ($2::int, $3::uuid))
                ORDER BY version_number DESC, id DESC
                LIMIT $4
            `, [id, cursor?.version_number || null, cursor?.id || null, limit + 1]);

            const page = pageResult(result.rows, limit, (row) => ({ version_number: row.version_number, id: row.id }));
            res.json({ versions: page.items, next_cursor: page.next_cursor });
        } catch (err) {
            logError('List versions error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to list versions' });
        }
    });

    /**
     * POST /api/tracks/:id/versions
     * Upload a new version of a track
     */
    router.post('/:id/versions', requireAuth, uploadLimiter, uploadDeadline(Number(process.env.UPLOAD_TIMEOUT_MS || 900_000)), audioUpload.single('audio'), async (req, res) => {
        let storageKey;
        try {
            const { id } = req.params;

            if (!req.file) {
                return res.status(400).json({ error: 'No audio file provided' });
            }

            // Validate MIME type
            const allowedTypes = ['audio/mpeg', 'audio/wav', 'audio/mp3', 'audio/x-wav'];
            if (!allowedTypes.includes(req.file.mimetype)) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(400).json({ error: 'Invalid file type. Only MP3 and WAV allowed.' });
            }

            // Verify ownership
            const track = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [id]
            );

            if (track.rows.length === 0) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(403).json({ error: 'Access denied' });
            }

            // Generate an immutable key independently of display version numbering.
            const durationSeconds = await audioDuration(req.file);
            const fileExt = req.file.mimetype === 'audio/mpeg' || req.file.mimetype === 'audio/mp3' ? 'mp3' : 'wav';
            storageKey = `tracks/${id}/versions/${crypto.randomBytes(16).toString('hex')}.${fileExt}`;

            await stageStorageObject(pool, {
                storageKey,
                bucket: BUCKET_NAME,
                ownerId: req.user.id,
                sizeBytes: req.file.size,
                mimeType: req.file.mimetype,
            });

            // Upload to MinIO from disk (streams file, avoids loading into memory)
            await minioClient.fPutObject(
                BUCKET_NAME,
                storageKey,
                req.file.path,
                { 'Content-Type': req.file.mimetype }
            );

            const client = await pool.connect();
            let newVersion;
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [id]);
                const versionResult = await client.query(
                    'SELECT COALESCE(MAX(version_number), 0) + 1 AS next_version FROM track_versions WHERE track_id = $1',
                    [id]
                );
                const result = await client.query(`
                    INSERT INTO track_versions (track_id, version_number, filename, storage_key, mime_type, size_bytes, duration_seconds)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    RETURNING *
                `, [id, versionResult.rows[0].next_version, req.file.originalname, storageKey, req.file.mimetype, req.file.size, durationSeconds]);
                newVersion = result.rows[0];
                await client.query(
                    'UPDATE tracks SET current_version_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                    [newVersion.id, id]
                );
                await activateStorageObject(client, storageKey, 'TRACK_VERSION', newVersion.id);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

            res.status(201).json({
                version: {
                    ...newVersion,
                    stream_url: streamUrl(newVersion.id),
                },
            });
        } catch (err) {
            // Clean up temp file on error
            if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
            if (storageKey) await abandonStorageObject(pool, storageKey, BUCKET_NAME).catch(() => {});
            logError('Upload version error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to upload version' });
        } finally {
            if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        }
    });

    /**
     * POST /api/tracks/:id/share
     * Generate or regenerate share token
     */
    router.post('/:id/share', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { makePublic } = req.body;

            // Verify ownership
            const existing = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [id]
            );

            if (existing.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (existing.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Generate new share token
            const shareToken = crypto.randomBytes(16).toString('hex');
            
            const result = await pool.query(`
                UPDATE tracks 
                SET share_token = $1,
                    release_status = $2,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $3
                RETURNING share_token, release_status
            `, [shareToken, makePublic ? 'PUBLIC' : 'PRIVATE', id]);

            res.json({ 
                shareToken: result.rows[0].share_token,
                releaseStatus: result.rows[0].release_status
            });
        } catch (err) {
            logError('Share track error:', err);
            res.status(500).json({ error: 'Failed to generate share link' });
        }
    });

    /**
     * PUT /api/tracks/:trackId/versions/:versionId
     * Rename a version
     */
    router.put('/:trackId/versions/:versionId', requireAuth, async (req, res) => {
        try {
            const { trackId, versionId } = req.params;
            const { filename } = req.body;

            if (!filename || !filename.trim()) {
                return res.status(400).json({ error: 'Filename is required' });
            }

            // Verify track ownership
            const track = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [trackId]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Update version filename
            const result = await pool.query(`
                UPDATE track_versions
                SET filename = $1
                WHERE id = $2 AND track_id = $3
                RETURNING *
            `, [sanitizeText(filename), versionId, trackId]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Version not found' });
            }

            res.json({ version: result.rows[0] });
        } catch (err) {
            logError('Rename version error:', err);
            res.status(500).json({ error: 'Failed to rename version' });
        }
    });

    /**
     * PUT /api/tracks/:trackId/versions/:versionId/activate
     * Set a version as the current version
     */
    router.put('/:trackId/versions/:versionId/activate', requireAuth, async (req, res) => {
        try {
            const track = await mutateVersion(pool, req.user.id, req.params.trackId, req.params.versionId, 'activate');
            res.json({ track: addResourceUrls(track) });
        } catch (error) {
            logError('activate version error:', error);
            res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to activate version' });
        }
    });

    /**
     * DELETE /api/tracks/:trackId/versions/:versionId
     * Delete a version (cannot delete if it's the only version or current version unless there's another)
     */
    router.delete('/:trackId/versions/:versionId', requireAuth, async (req, res) => {
        try {
            const track = await mutateVersion(pool, req.user.id, req.params.trackId, req.params.versionId, 'delete');
            res.json({ success: true });
        } catch (error) {
            logError('delete version error:', error);
            res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Failed to delete version' });
        }
    });

    router.post('/:trackId/versions/:versionId/download-grant', requireAuth, async (req, res) => {
        try {
            const { trackId, versionId } = req.params;
            const result = await pool.query(`
                SELECT tv.id FROM track_versions tv JOIN tracks t ON t.id = tv.track_id
                WHERE tv.id = $1 AND tv.track_id = $2 AND t.owner_id = $3
            `, [versionId, trackId, req.user.id]);
            if (!result.rows.length) return res.status(404).json({ error: 'Version not found' });
            const grant = issueGrant({
                purpose: 'version-download', track_id: trackId, version_id: versionId,
                user_id: req.user.id, auth_version: Number(req.user.auth_version),
            }, '5m');
            res.json({ url: `/api/tracks/${encodeURIComponent(trackId)}/versions/${encodeURIComponent(versionId)}/download?grant=${encodeURIComponent(grant)}` });
        } catch (error) {
            logError('Version grant error:', error);
            res.status(500).json({ error: 'Failed to create download grant' });
        }
    });

    /**
     * GET /api/tracks/:trackId/versions/:versionId/download
     * Download a specific version
     * Requires a short-lived, purpose-scoped download grant.
     */
    router.get('/:trackId/versions/:versionId/download', async (req, res) => {
        try {
            const { trackId, versionId } = req.params;
            const grant = readGrant(req.query.grant, {
                purpose: 'version-download', track_id: trackId, version_id: versionId,
            });
            if (!grant) return res.status(401).json({ error: 'Invalid or expired download grant' });

            // Verify track ownership
            const track = await pool.query(
                `SELECT t.owner_id, u.is_active, u.auth_version FROM tracks t
                 JOIN users u ON u.id = t.owner_id WHERE t.id = $1`,
                [trackId]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== grant.user_id || !track.rows[0].is_active
                || Number(track.rows[0].auth_version) !== Number(grant.auth_version)) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Get version info
            const version = await pool.query(
                'SELECT filename, storage_key, mime_type FROM track_versions WHERE id = $1 AND track_id = $2',
                [versionId, trackId]
            );

            if (version.rows.length === 0) {
                return res.status(404).json({ error: 'Version not found' });
            }

            const versionData = version.rows[0];

            // Stream file from MinIO
            const stat = await minioClient.statObject(BUCKET_NAME, versionData.storage_key);
            
            await sendObject(req, res, minioClient, BUCKET_NAME, versionData.storage_key, {
                filename: versionData.filename,
                headers: { 'Content-Type': versionData.mime_type || 'application/octet-stream', 'Content-Length': stat.size },
            });
        } catch (err) {
            logError('Download version error:', err);
            streamFailure(res, err, 'Failed to download version');
        }
    });

    /**
     * POST /api/tracks/:id/cover
     * Upload cover art for a track
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
            const track = await pool.query(
                'SELECT owner_id, cover_art_path FROM tracks WHERE id = $1',
                [id]
            );

            if (track.rows.length === 0) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                if (req.file.path) fs.unlink(req.file.path, () => {});
                return res.status(403).json({ error: 'Access denied' });
            }

            await prepareCover(req.file);
            // Generate storage key
            const fileExt = req.file.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : req.file.mimetype.split('/')[1];
            storageKey = `covers/tracks/${id}_${crypto.randomBytes(16).toString('hex')}.${fileExt}`;

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
                    UPDATE tracks SET cover_art_path = $1, updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2 AND owner_id = $3 RETURNING *
                `, [coverArtPath, id, req.user.id]);
                if (!result.rows.length) {
                    const error = new Error('Track no longer exists');
                    error.statusCode = 404;
                    throw error;
                }
                await activateStorageObject(client, storageKey, 'TRACK_COVER', id);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

            res.json({ track: addResourceUrls(result.rows[0]) });
        } catch (err) {
            if (storageKey) await abandonStorageObject(pool, storageKey, BUCKET_NAME).catch(() => {});
            logError('Upload cover art error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to upload cover art' });
        } finally {
            if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
        }
    });

    /**
     * DELETE /api/tracks/:id/cover
     * Remove cover art from a track
     */
    router.delete('/:id/cover', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            // Verify ownership
            const track = await pool.query(
                'SELECT owner_id, cover_art_path FROM tracks WHERE id = $1',
                [id]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Update track
            const result = await pool.query(`
                UPDATE tracks 
                SET cover_art_path = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING *
            `, [id]);

            res.json({ track: addResourceUrls(result.rows[0]) });
        } catch (err) {
            logError('Delete cover art error:', err);
            res.status(500).json({ error: 'Failed to delete cover art' });
        }
    });

    return router;
};
