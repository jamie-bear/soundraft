const { logError } = require('../lib/logging');
const express = require('express');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../middleware/auth');
const { sanitizeText } = require('../lib/text');
const { uploadDeadline } = require('../lib/uploads');
const { isUuid } = require('../lib/access');
const { decodeCursor, pageLimit, pageResult } = require('../lib/pagination');
const { abandonStorageObject, activateStorageObject, stageStorageObject } = require('../lib/object-lifecycle');
const { issueGrant, readGrant } = require('../lib/grants');

const { sendObject, streamFailure } = require('../lib/streaming');

const attachmentUploadLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many attachment uploads. Please wait a moment.' },
});

// V9: Dangerous file extensions that could enable XSS or code execution
const BLOCKED_EXTENSIONS = new Set([
    '.html', '.htm', '.xhtml', '.svg',
    '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx',
    '.exe', '.bat', '.cmd', '.sh', '.ps1',
    '.php', '.jsp', '.asp', '.aspx',
    '.swf', '.xss',
]);

module.exports = function(pool, minioClient, BUCKET_NAME, uploads) {
    const router = require('../lib/router').createRouter();
        const attachmentUpload = uploads.attachment || uploads;
    async function removeTempFile(file) {
        if (!file?.path) return;
        try {
            await fs.promises.unlink(file.path);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                logError('Attachment temp cleanup error:', err.message);
            }
        }
    }

    function attachmentDisposition(filename) {
        const fallback = filename.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/["\\]/g, '_');
        return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
    }

    /**
     * GET /api/attachments/track/:trackId
     * List attachments for a track (OWNER ONLY)
     */
    router.get('/track/:trackId', requireAuth, async (req, res) => {
        try {
            const { trackId } = req.params;
            const limit = pageLimit(req.query.limit);
            const cursor = decodeCursor(req.query.cursor, ['sort_order', 'created_at', 'id']);

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
                  AND ($2::int IS NULL OR sort_order > $2
                       OR (sort_order = $2 AND (created_at, id) < ($3::timestamptz, $4::uuid)))
                ORDER BY sort_order ASC, created_at DESC, id DESC
                LIMIT $5
            `, [trackId, cursor?.sort_order ?? null, cursor?.created_at || null, cursor?.id || null, limit + 1]);

            const page = pageResult(result.rows, limit, (row) => ({ sort_order: row.sort_order, created_at: row.created_at, id: row.id }));
            res.json({ attachments: page.items, next_cursor: page.next_cursor });
        } catch (err) {
            logError('List attachments error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to list attachments' });
        }
    });

    /**
     * POST /api/attachments/track/:trackId
     * Upload an attachment (OWNER ONLY)
     */
    router.post('/track/:trackId', requireAuth, attachmentUploadLimiter, uploadDeadline(Number(process.env.UPLOAD_TIMEOUT_MS || 900_000)), attachmentUpload.single('file'), async (req, res) => {
        let storageKey;
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

            // V9: Block dangerous file types
            const fileExt = '.' + (req.file.originalname.split('.').pop() || '').toLowerCase();
            if (BLOCKED_EXTENSIONS.has(fileExt)) {
                return res.status(400).json({ error: `File type ${fileExt} is not allowed for security reasons` });
            }

            // Generate storage key
            const safeFilename = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
            storageKey = `attachments/${trackId}/${require('crypto').randomBytes(16).toString('hex')}_${safeFilename}`;

            await stageStorageObject(pool, {
                storageKey,
                bucket: BUCKET_NAME,
                ownerId: req.user.id,
                sizeBytes: req.file.size,
                mimeType: req.file.mimetype,
            });

            // Upload to MinIO from Multer's disk storage.
            await minioClient.fPutObject(
                BUCKET_NAME,
                storageKey,
                req.file.path,
                { 'Content-Type': req.file.mimetype }
            );

            const client = await pool.connect();
            let result;
            try {
                await client.query('BEGIN');
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [trackId]);
                result = await client.query(`
                    INSERT INTO attachments (track_id, filename, storage_key, size_bytes, sort_order)
                    SELECT $1, $2, $3, $4, COALESCE(MAX(sort_order), -1) + 1
                    FROM attachments WHERE track_id = $1
                    RETURNING id, filename, size_bytes, sort_order, created_at
                `, [trackId, req.file.originalname, storageKey, req.file.size]);
                await activateStorageObject(client, storageKey, 'ATTACHMENT', result.rows[0].id);
                await client.query('COMMIT');
            } catch (error) {
                await client.query('ROLLBACK');
                throw error;
            } finally {
                client.release();
            }

            res.status(201).json({ attachment: result.rows[0] });
        } catch (err) {
            logError('Upload attachment error:', err);
            if (storageKey) await abandonStorageObject(pool, storageKey, BUCKET_NAME).catch(() => {});
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to upload attachment' });
        } finally {
            await removeTempFile(req.file);
        }
    });

    router.post('/:id/download-grant', requireAuth, async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT a.id FROM attachments a JOIN tracks t ON t.id = a.track_id
                WHERE a.id = $1 AND t.owner_id = $2
            `, [req.params.id, req.user.id]);
            if (!result.rows.length) return res.status(404).json({ error: 'Attachment not found' });
            const grant = issueGrant({
                purpose: 'attachment-download', attachment_id: req.params.id,
                user_id: req.user.id, auth_version: Number(req.user.auth_version),
            }, '5m');
            res.json({ url: `/api/attachments/${encodeURIComponent(req.params.id)}/download?grant=${encodeURIComponent(grant)}` });
        } catch (error) {
            logError('Attachment grant error:', error);
            res.status(500).json({ error: 'Failed to create download grant' });
        }
    });

    /**
     * GET /api/attachments/:id/download
     * Download an attachment (OWNER ONLY)
     * Requires a short-lived, purpose-scoped download grant.
     */
    router.get('/:id/download', async (req, res) => {
        try {
            const { id } = req.params;
            const grant = readGrant(req.query.grant, { purpose: 'attachment-download', attachment_id: id });
            if (!grant) return res.status(401).json({ error: 'Invalid or expired download grant' });

            // Get attachment with track info
            const result = await pool.query(`
                SELECT a.*, t.owner_id, u.is_active, u.auth_version
                FROM attachments a
                JOIN tracks t ON a.track_id = t.id
                JOIN users u ON u.id = t.owner_id
                WHERE a.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Attachment not found' });
            }

            const attachment = result.rows[0];

            // CRITICAL: OWNER ONLY
            if (attachment.owner_id !== grant.user_id || !attachment.is_active
                || Number(attachment.auth_version) !== Number(grant.auth_version)) {
                return res.status(403).json({ error: 'Access denied - attachments are private' });
            }

            // Stream file from MinIO
            const stat = await minioClient.statObject(BUCKET_NAME, attachment.storage_key);
            
            await sendObject(req, res, minioClient, BUCKET_NAME, attachment.storage_key, {
                filename: attachment.filename,
                headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size },
            });
        } catch (err) {
            logError('Download attachment error:', err);
            streamFailure(res, err, 'Failed to download attachment');
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

            const sanitizedFilename = sanitizeText(filename);
            if (!sanitizedFilename) {
                return res.status(400).json({ error: 'Filename is required' });
            }

            // Update filename in database
            const updated = await pool.query(`
                UPDATE attachments 
                SET filename = $1
                WHERE id = $2
                RETURNING id, filename, size_bytes, created_at
            `, [sanitizedFilename, id]);

            res.json({ attachment: updated.rows[0] });
        } catch (err) {
            logError('Rename attachment error:', err);
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

            if (!Array.isArray(attachmentIds) || new Set(attachmentIds).size !== attachmentIds.length
                || attachmentIds.some((value) => !isUuid(value))) {
                return res.status(400).json({ error: 'attachmentIds must be a unique array of attachment IDs' });
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
                await client.query('SET CONSTRAINTS attachments_track_order_unique DEFERRED');
                await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [trackId]);
                const current = await client.query('SELECT COUNT(*)::int AS count FROM attachments WHERE track_id = $1', [trackId]);
                if (current.rows[0].count !== attachmentIds.length) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'attachmentIds must contain every attachment exactly once' });
                }
                const updated = await client.query(`
                    UPDATE attachments a
                    SET sort_order = ordered.ordinal - 1
                    FROM unnest($2::uuid[]) WITH ORDINALITY AS ordered(attachment_id, ordinal)
                    WHERE a.track_id = $1 AND a.id = ordered.attachment_id
                `, [trackId, attachmentIds]);
                if (updated.rowCount !== attachmentIds.length) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'attachmentIds contains an unknown attachment' });
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
            logError('Reorder attachments error:', err);
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

            // Database trigger enqueues object deletion transactionally.
            await pool.query('DELETE FROM attachments WHERE id = $1', [id]);

            res.json({ success: true });
        } catch (err) {
            logError('Delete attachment error:', err);
            res.status(500).json({ error: 'Failed to delete attachment' });
        }
    });

    return router;
};
