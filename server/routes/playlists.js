const express = require('express');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sanitizeText } = require('../index');

const router = express.Router();

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many uploads. Please wait a moment.' },
});

module.exports = function(pool, minioClient, BUCKET_NAME, upload) {
    
    /**
     * GET /api/playlists
     * List all playlists for authenticated user
     * Optional query param: ?forTrack=trackId - includes whether each playlist contains the track
     */
    router.get('/', requireAuth, async (req, res) => {
        try {
            const { forTrack } = req.query;
            
            let query;
            let params = [req.user.id];
            
            if (forTrack) {
                // Include a flag for whether each playlist contains this track
                query = `
                    SELECT p.*, 
                           COUNT(pt.track_id) as track_count,
                           EXISTS(SELECT 1 FROM playlist_tracks pt2 WHERE pt2.playlist_id = p.id AND pt2.track_id = $2) as contains_track
                    FROM playlists p
                    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
                    WHERE p.owner_id = $1
                    GROUP BY p.id
                    ORDER BY p.created_at DESC
                `;
                params.push(forTrack);
            } else {
                query = `
                    SELECT p.*, 
                           COUNT(pt.track_id) as track_count
                    FROM playlists p
                    LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
                    WHERE p.owner_id = $1
                    GROUP BY p.id
                    ORDER BY p.created_at DESC
                `;
            }
            
            const result = await pool.query(query, params);
            res.json({ playlists: result.rows });
        } catch (err) {
            console.error('List playlists error:', err);
            res.status(500).json({ error: 'Failed to list playlists' });
        }
    });

    /**
     * POST /api/playlists
     * Create a new playlist
     */
    router.post('/', requireAuth, async (req, res) => {
        try {
            const { title, artist, type = 'PLAYLIST' } = req.body;

            if (!title) {
                return res.status(400).json({ error: 'Title is required' });
            }

            const shareToken = uuidv4().replace(/-/g, '');

            const result = await pool.query(`
                INSERT INTO playlists (owner_id, title, artist, type, share_token)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `, [req.user.id, sanitizeText(title), sanitizeText(artist), type, shareToken]);

            res.status(201).json({ playlist: result.rows[0] });
        } catch (err) {
            console.error('Create playlist error:', err);
            res.status(500).json({ error: 'Failed to create playlist' });
        }
    });

    /**
     * GET /api/playlists/:id
     * Get playlist with tracks
     * The :id can be either a UUID or a share_token
     */
    router.get('/:id', optionalAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { token } = req.query;

            // Check if id looks like a UUID or a share token
            const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

            let playlistResult;
            if (isUUID) {
                playlistResult = await pool.query(
                    'SELECT * FROM playlists WHERE id = $1',
                    [id]
                );
            } else {
                // Look up by share_token
                playlistResult = await pool.query(
                    'SELECT * FROM playlists WHERE share_token = $1',
                    [id]
                );
            }

            if (playlistResult.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            const playlist = playlistResult.rows[0];

            // Check access
            const isOwner = req.user && req.user.id === playlist.owner_id;
            // For share token lookups, the token in URL serves as validation
            const hasValidToken = !isUUID || (token && token === playlist.share_token);
            const isPublic = playlist.is_public;
            
            // New Requirement: Private playlists require login.
            if (!isOwner) {
                // If Private (not public), strictly require authentication
                if (!isPublic && !req.user) {
                    return res.status(401).json({ error: 'Authentication required' });
                }

                if (!hasValidToken && !isPublic) {
                    return res.status(403).json({ error: 'Access denied' });
                }
            }

            // Get tracks with order (use playlist.id, not the param id)
            const tracksResult = await pool.query(`
                SELECT t.id, t.title, t.artist, t.status, t.type, t.cover_art_path,
                       t.current_version_id,
                       tv.duration_seconds,
                       pt.sort_order
                FROM playlist_tracks pt
                JOIN tracks t ON pt.track_id = t.id
                LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                WHERE pt.playlist_id = $1
                ORDER BY pt.sort_order ASC
            `, [playlist.id]);

            if (!isOwner) {
                delete playlist.share_token;
            }

            res.json({ 
                playlist,
                tracks: tracksResult.rows,
                isOwner
            });
        } catch (err) {
            console.error('Get playlist error:', err);
            res.status(500).json({ error: 'Failed to get playlist' });
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
                    artist = COALESCE($2, artist),
                    type = COALESCE($3, type),
                    is_public = COALESCE($4, is_public),
                    comment_access = COALESCE($5, comment_access)
                WHERE id = $6
                RETURNING *
            `, [title ? sanitizeText(title) : null, artist ? sanitizeText(artist) : null, type, is_public, comment_access, id]);

            res.json({ playlist: result.rows[0] });
        } catch (err) {
            console.error('Update playlist error:', err);
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
            console.error('Delete playlist error:', err);
            res.status(500).json({ error: 'Failed to delete playlist' });
        }
    });

    /**
     * POST /api/playlists/:id/tracks
     * Add a track to playlist
     */
    router.post('/:id/tracks', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { trackId } = req.body;

            if (!trackId) {
                return res.status(400).json({ error: 'trackId is required' });
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

            // Verify track exists and user owns it
            const track = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [trackId]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (track.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'You can only add your own tracks' });
            }

            // Get next sort order
            const orderResult = await pool.query(
                'SELECT COALESCE(MAX(sort_order), -1) + 1 as next_order FROM playlist_tracks WHERE playlist_id = $1',
                [id]
            );

            await pool.query(`
                INSERT INTO playlist_tracks (playlist_id, track_id, sort_order)
                VALUES ($1, $2, $3)
                ON CONFLICT (playlist_id, track_id) DO NOTHING
            `, [id, trackId, orderResult.rows[0].next_order]);

            res.status(201).json({ success: true });
        } catch (err) {
            console.error('Add track to playlist error:', err);
            res.status(500).json({ error: 'Failed to add track' });
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
            console.error('Remove track from playlist error:', err);
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

        if (!Array.isArray(trackIds)) {
            return res.status(400).json({ error: 'trackIds must be an array' });
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

            for (let i = 0; i < trackIds.length; i++) {
                await client.query(
                    'UPDATE playlist_tracks SET sort_order = $1 WHERE playlist_id = $2 AND track_id = $3',
                    [i, id, trackIds[i]]
                );
            }

            await client.query('COMMIT');
            res.json({ success: true });
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Reorder error:', e);
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
            const shareToken = uuidv4().replace(/-/g, '');
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

            res.status(201).json({ playlist: newPlaylist.rows[0] });
        } catch (err) {
            await client.query('ROLLBACK');
            console.error('Duplicate playlist error:', err);
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

            // Delete old cover art if exists
            const oldCoverPath = playlist.rows[0].cover_art_path;
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
            const storageKey = `covers/playlists/${id}_${Date.now()}.${fileExt}`;

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

            // Update playlist
            const result = await pool.query(`
                UPDATE playlists 
                SET cover_art_path = $1
                WHERE id = $2
                RETURNING *
            `, [coverArtPath, id]);

            res.json({ playlist: result.rows[0] });
        } catch (err) {
            console.error('Upload cover art error:', err);
            res.status(500).json({ error: 'Failed to upload cover art' });
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

            // Delete from storage if exists
            const coverPath = playlist.rows[0].cover_art_path;
            if (coverPath) {
                try {
                    const storageKey = coverPath.replace(/^.*\/storage\//, '');
                    await minioClient.removeObject(BUCKET_NAME, storageKey);
                } catch (e) {
                    console.error('Failed to delete cover from storage:', e.message);
                }
            }

            // Update playlist
            const result = await pool.query(`
                UPDATE playlists 
                SET cover_art_path = NULL
                WHERE id = $1
                RETURNING *
            `, [id]);

            res.json({ playlist: result.rows[0] });
        } catch (err) {
            console.error('Delete cover art error:', err);
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
            const shareToken = uuidv4().replace(/-/g, '');
            
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
            console.error('Share playlist error:', err);
            res.status(500).json({ error: 'Failed to generate share link' });
        }
    });

    return router;
};
