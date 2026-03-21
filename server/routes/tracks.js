const express = require('express');
const { v4: uuidv4 } = require('uuid');
const mm = require('music-metadata');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { requireAuth, requireAuthWithQuery, optionalAuth, checkShareAccess } = require('../middleware/auth');
const { sanitizeText } = require('../index');

const router = express.Router();

// Rate limiter for upload endpoints — 10/minute per IP
const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads. Please wait a moment.' },
});

module.exports = function(pool, minioClient, BUCKET_NAME, upload) {
    
    /**
     * GET /api/tracks
     * List all tracks for authenticated user
     */
    router.get('/', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT t.*, 
                       tv.duration_seconds,
                       tv.version_number as current_version_number
                FROM tracks t
                LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                WHERE t.owner_id = $1
                ORDER BY t.updated_at DESC
            `, [req.user.id]);

            res.json({ tracks: result.rows });
        } catch (err) {
            console.error('List tracks error:', err);
            res.status(500).json({ error: 'Failed to list tracks' });
        }
    });

    /**
     * POST /api/tracks
     * Create a new track
     */
    router.post('/', requireAuth, async (req, res) => {
        try {
            const { title, artist, status = 'WIP', type = 'RELEASE' } = req.body;

            if (!title) {
                return res.status(400).json({ error: 'Title is required' });
            }

            // Generate share token
            const shareToken = uuidv4().replace(/-/g, '');

            const result = await pool.query(`
                INSERT INTO tracks (owner_id, title, artist, status, type, share_token)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
            `, [req.user.id, sanitizeText(title), sanitizeText(artist), status, type, shareToken]);

            res.status(201).json({ track: result.rows[0] });
        } catch (err) {
            console.error('Create track error:', err);
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

            // Check if id looks like a UUID or a share token
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
            
            let result;
            if (isUUID) {
                result = await pool.query(`
                    SELECT t.*, 
                           tv.duration_seconds,
                           tv.version_number as current_version_number,
                           tv.filename as current_filename
                    FROM tracks t
                    LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                    WHERE t.id = $1
                `, [id]);
            } else {
                // Look up by share_token
                result = await pool.query(`
                    SELECT t.*, 
                           tv.duration_seconds,
                           tv.version_number as current_version_number,
                           tv.filename as current_filename
                    FROM tracks t
                    LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                    WHERE t.share_token = $1
                `, [id]);
            }

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            const track = result.rows[0];

            // Check access
            const isOwner = req.user && req.user.id === track.owner_id;
            // For share token lookups, the token in URL serves as validation
            const hasValidToken = !isUUID || (token && token === track.share_token);
            const isPublic = track.release_status === 'PUBLIC';
            const isPrivate = track.release_status === 'PRIVATE';

            // Access Logic:
            // 1. Owner always has access
            // 2. Public tracks: Accessible if hasValidToken (or if we allow public browsing without token, but here token is key for shared links)
            //    Actually, if isPublic, we might allow access even without token if we implement a public feed, but for /:id endpoint:
            //    If accessed via UUID, isPublic should probably allow it? 
            //    The current logic `!isUUID || (token ...)` implies UUID access requires token unless isOwner?
            //    Wait, `hasValidToken` is true if `!isUUID` (accessed via /share/token route logic in frontend calling API with token as ID?).
            //    Actually API `/:id` handles both.
            
            // New Requirement: Private tracks require login.
            
            if (!isOwner) {
                // If accessed via UUID and no token provided, deny (unless public? logic below handles it)
                
                // If Private, strictly require authentication
                if (isPrivate && !req.user) {
                    return res.status(401).json({ error: 'Authentication required' });
                }

                // General access check
                if (!hasValidToken && !isPublic) {
                    return res.status(403).json({ error: 'Access denied' });
                }
            }

            // Remove sensitive fields for non-owners
            if (!isOwner) {
                delete track.share_token;
            }

            res.json({ track, isOwner });
        } catch (err) {
            console.error('Get track error:', err);
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
                    artist = COALESCE($2, artist),
                    status = COALESCE($3, status),
                    type = COALESCE($4, type),
                    release_status = COALESCE($5, release_status),
                    comment_access = COALESCE($6, comment_access),
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $7
                RETURNING *
            `, [title ? sanitizeText(title) : null, artist ? sanitizeText(artist) : null, status, type, release_status, comment_access, id]);

            res.json({ track: result.rows[0] });
        } catch (err) {
            console.error('Update track error:', err);
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

            // Get all versions to delete from storage
            const versions = await pool.query(
                'SELECT storage_key FROM track_versions WHERE track_id = $1',
                [id]
            );

            // Delete from MinIO
            for (const version of versions.rows) {
                try {
                    await minioClient.removeObject(BUCKET_NAME, version.storage_key);
                } catch (e) {
                    console.error('MinIO delete error:', e.message);
                }
            }

            // Delete from DB (cascades to versions, attachments)
            await pool.query('DELETE FROM tracks WHERE id = $1', [id]);

            res.json({ success: true });
        } catch (err) {
            console.error('Delete track error:', err);
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
                ORDER BY version_number DESC
            `, [id]);

            res.json({ versions: result.rows });
        } catch (err) {
            console.error('List versions error:', err);
            res.status(500).json({ error: 'Failed to list versions' });
        }
    });

    /**
     * POST /api/tracks/:id/versions
     * Upload a new version of a track
     */
    router.post('/:id/versions', requireAuth, uploadLimiter, upload.single('audio'), async (req, res) => {
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

            // Get next version number
            const versionResult = await pool.query(
                'SELECT COALESCE(MAX(version_number), 0) + 1 as next_version FROM track_versions WHERE track_id = $1',
                [id]
            );
            const versionNumber = versionResult.rows[0].next_version;

            // Generate storage key
            const fileExt = req.file.originalname.split('.').pop();
            const storageKey = `tracks/${id}/v${versionNumber}_${Date.now()}.${fileExt}`;

            // Upload to MinIO from disk (streams file, avoids loading into memory)
            await minioClient.fPutObject(
                BUCKET_NAME,
                storageKey,
                req.file.path,
                { 'Content-Type': req.file.mimetype }
            );

            // Extract duration using music-metadata
            let durationSeconds = 0;
            try {
                const metadata = await mm.parseFile(req.file.path);
                if (metadata.format.duration) {
                    durationSeconds = Math.round(metadata.format.duration);
                }
            } catch (err) {
                console.error('Failed to parse audio duration:', err.message);
            }

            // Clean up temp file
            fs.unlink(req.file.path, () => {});

            // Create version record
            const result = await pool.query(`
                INSERT INTO track_versions (track_id, version_number, filename, storage_key, mime_type, size_bytes, duration_seconds)
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
            `, [id, versionNumber, req.file.originalname, storageKey, req.file.mimetype, req.file.size, durationSeconds]);

            const newVersion = result.rows[0];

            // Update track's current version
            await pool.query(
                'UPDATE tracks SET current_version_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                [newVersion.id, id]
            );

            res.status(201).json({ version: newVersion });
        } catch (err) {
            // Clean up temp file on error
            if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
            console.error('Upload version error:', err);
            res.status(500).json({ error: 'Failed to upload version' });
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
            const shareToken = uuidv4().replace(/-/g, '');
            
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
            console.error('Share track error:', err);
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
            console.error('Rename version error:', err);
            res.status(500).json({ error: 'Failed to rename version' });
        }
    });

    /**
     * PUT /api/tracks/:trackId/versions/:versionId/activate
     * Set a version as the current version
     */
    router.put('/:trackId/versions/:versionId/activate', requireAuth, async (req, res) => {
        try {
            const { trackId, versionId } = req.params;

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

            // Verify version exists
            const version = await pool.query(
                'SELECT id FROM track_versions WHERE id = $1 AND track_id = $2',
                [versionId, trackId]
            );

            if (version.rows.length === 0) {
                return res.status(404).json({ error: 'Version not found' });
            }

            // Update track's current version
            const result = await pool.query(`
                UPDATE tracks 
                SET current_version_id = $1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
                RETURNING *
            `, [versionId, trackId]);

            res.json({ track: result.rows[0] });
        } catch (err) {
            console.error('Activate version error:', err);
            res.status(500).json({ error: 'Failed to activate version' });
        }
    });

    /**
     * DELETE /api/tracks/:trackId/versions/:versionId
     * Delete a version (cannot delete if it's the only version or current version unless there's another)
     */
    router.delete('/:trackId/versions/:versionId', requireAuth, async (req, res) => {
        try {
            const { trackId, versionId } = req.params;

            // Verify track ownership
            const track = await pool.query(
                'SELECT owner_id, current_version_id FROM tracks WHERE id = $1',
                [trackId]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }

            // Get version info
            const version = await pool.query(
                'SELECT storage_key FROM track_versions WHERE id = $1 AND track_id = $2',
                [versionId, trackId]
            );

            if (version.rows.length === 0) {
                return res.status(404).json({ error: 'Version not found' });
            }

            // Count total versions
            const countResult = await pool.query(
                'SELECT COUNT(*) as count FROM track_versions WHERE track_id = $1',
                [trackId]
            );

            if (parseInt(countResult.rows[0].count) <= 1) {
                return res.status(400).json({ error: 'Cannot delete the only version' });
            }

            // If deleting current version, set another as current
            if (track.rows[0].current_version_id === versionId) {
                const otherVersion = await pool.query(
                    'SELECT id FROM track_versions WHERE track_id = $1 AND id != $2 ORDER BY version_number DESC LIMIT 1',
                    [trackId, versionId]
                );
                
                if (otherVersion.rows.length > 0) {
                    await pool.query(
                        'UPDATE tracks SET current_version_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                        [otherVersion.rows[0].id, trackId]
                    );
                }
            }

            // Delete from MinIO
            try {
                await minioClient.removeObject(BUCKET_NAME, version.rows[0].storage_key);
            } catch (e) {
                console.error('MinIO delete error:', e.message);
            }

            // Delete from database
            await pool.query('DELETE FROM track_versions WHERE id = $1', [versionId]);

            res.json({ success: true });
        } catch (err) {
            console.error('Delete version error:', err);
            res.status(500).json({ error: 'Failed to delete version' });
        }
    });

    /**
     * GET /api/tracks/:trackId/versions/:versionId/download
     * Download a specific version
     * Accepts auth token via header OR ?auth= query param for direct browser downloads
     */
    router.get('/:trackId/versions/:versionId/download', requireAuthWithQuery, async (req, res) => {
        try {
            const { trackId, versionId } = req.params;

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
            
            res.setHeader('Content-Type', versionData.mime_type || 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${versionData.filename}"`);
            res.setHeader('Content-Length', stat.size);

            const stream = await minioClient.getObject(BUCKET_NAME, versionData.storage_key);
            stream.pipe(res);
        } catch (err) {
            console.error('Download version error:', err);
            res.status(500).json({ error: 'Failed to download version' });
        }
    });

    /**
     * POST /api/tracks/:id/cover
     * Upload cover art for a track
     * Requirements: Square aspect ratio, max 20MB upload, auto-compress if >6MB
     */
    router.post('/:id/cover', requireAuth, uploadLimiter, upload.single('cover'), async (req, res) => {
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

            // Delete old cover art if exists
            const oldCoverPath = track.rows[0].cover_art_path;
            if (oldCoverPath) {
                try {
                    const oldKey = oldCoverPath.replace(/^.*\/storage\//, '');
                    await minioClient.removeObject(BUCKET_NAME, oldKey);
                } catch (e) {
                    console.error('Failed to delete old cover:', e.message);
                }
            }

            // Generate storage key
            const fileExt = req.file.mimetype.split('/')[1] === 'jpeg' ? 'jpg' : req.file.mimetype.split('/')[1];
            const storageKey = `covers/tracks/${id}_${Date.now()}.${fileExt}`;

            // Upload to MinIO from disk
            await minioClient.fPutObject(
                BUCKET_NAME,
                storageKey,
                req.file.path,
                { 'Content-Type': req.file.mimetype }
            );

            // Clean up temp file
            fs.unlink(req.file.path, () => {});

            // Generate the cover art URL path
            const coverArtPath = `/api/storage/${storageKey}`;

            // Update track
            const result = await pool.query(`
                UPDATE tracks 
                SET cover_art_path = $1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $2
                RETURNING *
            `, [coverArtPath, id]);

            res.json({ track: result.rows[0] });
        } catch (err) {
            console.error('Upload cover art error:', err);
            res.status(500).json({ error: 'Failed to upload cover art' });
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

            // Delete from storage if exists
            const coverPath = track.rows[0].cover_art_path;
            if (coverPath) {
                try {
                    const storageKey = coverPath.replace(/^.*\/storage\//, '');
                    await minioClient.removeObject(BUCKET_NAME, storageKey);
                } catch (e) {
                    console.error('Failed to delete cover from storage:', e.message);
                }
            }

            // Update track
            const result = await pool.query(`
                UPDATE tracks 
                SET cover_art_path = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING *
            `, [id]);

            res.json({ track: result.rows[0] });
        } catch (err) {
            console.error('Delete cover art error:', err);
            res.status(500).json({ error: 'Failed to delete cover art' });
        }
    });

    return router;
};
