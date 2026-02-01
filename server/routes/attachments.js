const express = require('express');
const { requireAuth, requireAuthWithQuery } = require('../middleware/auth');

const router = express.Router();

module.exports = function(pool, minioClient, BUCKET_NAME, upload) {
    
    /**
     * GET /api/attachments/track/:trackId
     * List attachments for a track (OWNER ONLY)
     */
    router.get('/track/:trackId', requireAuth, async (req, res) => {
        try {
            const { trackId } = req.params;

            // CRITICAL: Verify track ownership
            const track = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [trackId]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            // OWNER ONLY - This is a critical security check
            if (track.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied - attachments are private' });
            }

            const result = await pool.query(`
                SELECT id, filename, size_bytes, sort_order, created_at
                FROM attachments
                WHERE track_id = $1
                ORDER BY sort_order ASC, created_at DESC
            `, [trackId]);

            res.json({ attachments: result.rows });
        } catch (err) {
            console.error('List attachments error:', err);
            res.status(500).json({ error: 'Failed to list attachments' });
        }
    });

    /**
     * POST /api/attachments/track/:trackId
     * Upload an attachment (OWNER ONLY)
     */
    router.post('/track/:trackId', requireAuth, upload.single('file'), async (req, res) => {
        try {
            const { trackId } = req.params;

            if (!req.file) {
                return res.status(400).json({ error: 'No file provided' });
            }

            // CRITICAL: Verify track ownership
            const track = await pool.query(
                'SELECT owner_id FROM tracks WHERE id = $1',
                [trackId]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            // OWNER ONLY
            if (track.rows[0].owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied - only owner can upload attachments' });
            }

            // Generate storage key
            const timestamp = Date.now();
            const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
            const storageKey = `attachments/${trackId}/${timestamp}_${safeFilename}`;

            // Upload to MinIO
            await minioClient.putObject(
                BUCKET_NAME,
                storageKey,
                req.file.buffer,
                req.file.size,
                { 'Content-Type': req.file.mimetype }
            );

            // Create database record
            const result = await pool.query(`
                INSERT INTO attachments (track_id, filename, storage_key, size_bytes)
                VALUES ($1, $2, $3, $4)
                RETURNING id, filename, size_bytes, created_at
            `, [trackId, req.file.originalname, storageKey, req.file.size]);

            res.status(201).json({ attachment: result.rows[0] });
        } catch (err) {
            console.error('Upload attachment error:', err);
            res.status(500).json({ error: 'Failed to upload attachment' });
        }
    });

    /**
     * GET /api/attachments/:id/download
     * Download an attachment (OWNER ONLY)
     * Accepts auth token via header OR ?auth= query param for direct browser downloads
     */
    router.get('/:id/download', requireAuthWithQuery, async (req, res) => {
        try {
            const { id } = req.params;

            // Get attachment with track info
            const result = await pool.query(`
                SELECT a.*, t.owner_id
                FROM attachments a
                JOIN tracks t ON a.track_id = t.id
                WHERE a.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Attachment not found' });
            }

            const attachment = result.rows[0];

            // CRITICAL: OWNER ONLY
            if (attachment.owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied - attachments are private' });
            }

            // Stream file from MinIO
            const stat = await minioClient.statObject(BUCKET_NAME, attachment.storage_key);
            
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Disposition', `attachment; filename="${attachment.filename}"`);
            res.setHeader('Content-Length', stat.size);

            const stream = await minioClient.getObject(BUCKET_NAME, attachment.storage_key);
            stream.pipe(res);
        } catch (err) {
            console.error('Download attachment error:', err);
            res.status(500).json({ error: 'Failed to download attachment' });
        }
    });

    /**
     * PUT /api/attachments/:id
     * Rename an attachment (OWNER ONLY)
     */
    router.put('/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;
            const { filename } = req.body;

            if (!filename || !filename.trim()) {
                return res.status(400).json({ error: 'Filename is required' });
            }

            // Get attachment with track info
            const result = await pool.query(`
                SELECT a.*, t.owner_id
                FROM attachments a
                JOIN tracks t ON a.track_id = t.id
                WHERE a.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Attachment not found' });
            }

            const attachment = result.rows[0];

            // CRITICAL: OWNER ONLY
            if (attachment.owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied - only owner can rename attachments' });
            }

            // Update filename in database
            const updated = await pool.query(`
                UPDATE attachments 
                SET filename = $1
                WHERE id = $2
                RETURNING id, filename, size_bytes, created_at
            `, [filename.trim(), id]);

            res.json({ attachment: updated.rows[0] });
        } catch (err) {
            console.error('Rename attachment error:', err);
            res.status(500).json({ error: 'Failed to rename attachment' });
        }
    });

    /**
     * PUT /api/attachments/track/:trackId/reorder
     * Reorder attachments for a track (OWNER ONLY)
     */
    router.put('/track/:trackId/reorder', requireAuth, async (req, res) => {
        try {
            const { trackId } = req.params;
            const { attachmentIds } = req.body;

            if (!Array.isArray(attachmentIds)) {
                return res.status(400).json({ error: 'attachmentIds must be an array' });
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

            // Update sort_order for each attachment
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                for (let i = 0; i < attachmentIds.length; i++) {
                    await client.query(
                        'UPDATE attachments SET sort_order = $1 WHERE id = $2 AND track_id = $3',
                        [i, attachmentIds[i], trackId]
                    );
                }

                await client.query('COMMIT');
                res.json({ success: true });
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        } catch (err) {
            console.error('Reorder attachments error:', err);
            res.status(500).json({ error: 'Failed to reorder attachments' });
        }
    });

    /**
     * DELETE /api/attachments/:id
     * Delete an attachment (OWNER ONLY)
     */
    router.delete('/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            // Get attachment with track info
            const result = await pool.query(`
                SELECT a.*, t.owner_id
                FROM attachments a
                JOIN tracks t ON a.track_id = t.id
                WHERE a.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Attachment not found' });
            }

            const attachment = result.rows[0];

            // CRITICAL: OWNER ONLY
            if (attachment.owner_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied - only owner can delete attachments' });
            }

            // Delete from MinIO
            try {
                await minioClient.removeObject(BUCKET_NAME, attachment.storage_key);
            } catch (e) {
                console.error('MinIO delete error:', e.message);
            }

            // Delete from database
            await pool.query('DELETE FROM attachments WHERE id = $1', [id]);

            res.json({ success: true });
        } catch (err) {
            console.error('Delete attachment error:', err);
            res.status(500).json({ error: 'Failed to delete attachment' });
        }
    });

    return router;
};
