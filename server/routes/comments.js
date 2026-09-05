const { logError } = require('../lib/logging');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { sanitizeText } = require('../lib/text');
const { evaluateEntityAccess } = require('../lib/access');
const { decodeCursor, pageLimit, pageResult } = require('../lib/pagination');


const commentLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many comments. Please wait a moment.' },
});

module.exports = function(pool) {
    const router = require('../lib/router').createRouter();
    
    /**
     * Helper function to check comment access
     * Returns: { canView: boolean, canPost: boolean, isOwner: boolean }
     */
    async function checkCommentAccess(entityType, entityId, userId, shareToken) {
        const table = entityType === 'track' ? 'tracks' : 'playlists';
        const visibilityColumn = entityType === 'track' ? 'release_status' : 'is_public';
        const result = await pool.query(
            `SELECT id, owner_id, share_token, comment_access, ${visibilityColumn} FROM ${table} WHERE id = $1`,
            [entityId]
        );

        if (result.rows.length === 0) {
            return { exists: false };
        }

        const entity = result.rows[0];
        const resourceAccess = evaluateEntityAccess({
            resource: entity,
            resourceType: entityType,
            shareToken,
            user: userId ? { id: userId } : null,
        });
        const isOwner = resourceAccess.isOwner;
        const commentAccess = entity.comment_access || 'PRIVATE';

        // Owner can always view and post
        if (isOwner) {
            return { exists: true, canView: true, canPost: true, isOwner: true };
        }

        if (!resourceAccess.allowed) {
            return { exists: true, canView: false, canPost: false, isOwner: false };
        }

        // Check access based on comment_access setting
        switch (commentAccess) {
            case 'PRIVATE':
                // Only owner can view and post
                return { exists: true, canView: false, canPost: false, isOwner: false };
            case 'PUBLIC_VIEW':
                // Anyone with token can view, only owner can post
                return { 
                    exists: true, 
                    canView: true,
                    canPost: false, 
                    isOwner: false 
                };
            case 'PUBLIC_FULL':
                // Anyone with token can view, only signed-in users can post
                return { 
                    exists: true, 
                    canView: true,
                    canPost: !!userId,
                    isOwner: false 
                };
            default:
                return { exists: true, canView: false, canPost: false, isOwner: false };
        }
    }

    /**
     * GET /api/comments/track/:trackId
     * List comments for a track
     */
    router.get('/track/:trackId', optionalAuth, async (req, res) => {
        try {
            const { trackId } = req.params;
            const { token } = req.query;
            const limit = pageLimit(req.query.limit);
            const cursor = decodeCursor(req.query.cursor, ['created_at', 'id']);

            const access = await checkCommentAccess('track', trackId, req.user?.id, token);

            if (!access.exists) {
                return res.status(404).json({ error: 'Track not found' });
            }

            // If comments are private (canView is false), return empty array with flag
            if (!access.canView) {
                return res.json({ comments: [], canPost: false, commentsHidden: true });
            }

            const result = await pool.query(`
                SELECT c.id, c.body, c.audio_timestamp, c.created_at,
                       u.id as user_id, u.email as user_email
                FROM comments c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.track_id = $1
                  AND ($2::timestamptz IS NULL OR (c.created_at, c.id) > ($2::timestamptz, $3::uuid))
                ORDER BY c.created_at ASC, c.id ASC LIMIT $4
            `, [trackId, cursor?.created_at || null, cursor?.id || null, limit + 1]);

            // Mask emails for non-owners
            const page = pageResult(result.rows, limit, row => ({ created_at: row.created_at, id: row.id }));
            const comments = page.items.map(comment => ({
                ...comment,
                user_email: access.isOwner ? comment.user_email : (comment.user_email ? 'User' : 'Anonymous')
            }));

            res.json({ comments, canPost: access.canPost, commentsHidden: false, next_cursor: page.next_cursor });
        } catch (err) {
            logError('List track comments error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to list comments' });
        }
    });

    /**
     * POST /api/comments/track/:trackId
     * Add a comment to a track
     */
    router.post('/track/:trackId', commentLimiter, optionalAuth, async (req, res) => {
        try {
            const { trackId } = req.params;
            const { body, audioTimestamp, token } = req.body;

            const sanitizedBody = sanitizeText(body);
            if (!sanitizedBody) {
                return res.status(400).json({ error: 'Comment body is required' });
            }
            if (sanitizedBody.length > 10000) {
                return res.status(400).json({ error: 'Comment body must be 10000 characters or fewer' });
            }
            if (
                audioTimestamp !== undefined &&
                audioTimestamp !== null &&
                (!Number.isFinite(audioTimestamp) || audioTimestamp < 0)
            ) {
                return res.status(400).json({ error: 'audioTimestamp must be a non-negative number' });
            }

            const access = await checkCommentAccess('track', trackId, req.user?.id, token);

            if (!access.exists) {
                return res.status(404).json({ error: 'Track not found' });
            }

            if (!access.canPost) {
                return res.status(403).json({ error: 'You cannot post comments here' });
            }

            const result = await pool.query(`
                INSERT INTO comments (user_id, track_id, body, audio_timestamp)
                VALUES ($1, $2, $3, $4)
                RETURNING id, body, audio_timestamp, created_at
            `, [req.user?.id || null, trackId, sanitizedBody, audioTimestamp ?? null]);

            const comment = result.rows[0];
            
            res.status(201).json({ 
                comment: {
                    ...comment,
                    user_email: req.user?.email || 'Anonymous'
                }
            });
        } catch (err) {
            logError('Add track comment error:', err);
            res.status(500).json({ error: 'Failed to add comment' });
        }
    });

    /**
     * GET /api/comments/playlist/:playlistId
     * List comments for a playlist
     */
    router.get('/playlist/:playlistId', optionalAuth, async (req, res) => {
        try {
            const { playlistId } = req.params;
            const { token } = req.query;
            const limit = pageLimit(req.query.limit);
            const cursor = decodeCursor(req.query.cursor, ['created_at', 'id']);

            const access = await checkCommentAccess('playlist', playlistId, req.user?.id, token);

            if (!access.exists) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            // If comments are private (canView is false), return empty array with flag
            if (!access.canView) {
                return res.json({ comments: [], canPost: false, commentsHidden: true });
            }

            const result = await pool.query(`
                SELECT c.id, c.body, c.created_at,
                       u.id as user_id, u.email as user_email
                FROM comments c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.playlist_id = $1
                  AND ($2::timestamptz IS NULL OR (c.created_at, c.id) > ($2::timestamptz, $3::uuid))
                ORDER BY c.created_at ASC, c.id ASC LIMIT $4
            `, [playlistId, cursor?.created_at || null, cursor?.id || null, limit + 1]);

            // Mask emails for non-owners
            const page = pageResult(result.rows, limit, row => ({ created_at: row.created_at, id: row.id }));
            const comments = page.items.map(comment => ({
                ...comment,
                user_email: access.isOwner ? comment.user_email : (comment.user_email ? 'User' : 'Anonymous')
            }));

            res.json({ comments, canPost: access.canPost, commentsHidden: false, next_cursor: page.next_cursor });
        } catch (err) {
            logError('List playlist comments error:', err);
            res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to list comments' });
        }
    });

    /**
     * POST /api/comments/playlist/:playlistId
     * Add a comment to a playlist
     */
    router.post('/playlist/:playlistId', commentLimiter, optionalAuth, async (req, res) => {
        try {
            const { playlistId } = req.params;
            const { body, token } = req.body;

            const sanitizedBody = sanitizeText(body);
            if (!sanitizedBody) {
                return res.status(400).json({ error: 'Comment body is required' });
            }
            if (sanitizedBody.length > 10000) {
                return res.status(400).json({ error: 'Comment body must be 10000 characters or fewer' });
            }

            const access = await checkCommentAccess('playlist', playlistId, req.user?.id, token);

            if (!access.exists) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            if (!access.canPost) {
                return res.status(403).json({ error: 'You cannot post comments here' });
            }

            const result = await pool.query(`
                INSERT INTO comments (user_id, playlist_id, body)
                VALUES ($1, $2, $3)
                RETURNING id, body, created_at
            `, [req.user?.id || null, playlistId, sanitizedBody]);

            const comment = result.rows[0];
            
            res.status(201).json({ 
                comment: {
                    ...comment,
                    user_email: req.user?.email || 'Anonymous'
                }
            });
        } catch (err) {
            logError('Add playlist comment error:', err);
            res.status(500).json({ error: 'Failed to add comment' });
        }
    });

    /**
     * DELETE /api/comments/:id
     * Delete a comment (owner of comment or entity owner)
     */
    router.delete('/:id', requireAuth, async (req, res) => {
        try {
            const { id } = req.params;

            // Get comment with entity info
            const result = await pool.query(`
                SELECT c.*, 
                       t.owner_id as track_owner_id,
                       p.owner_id as playlist_owner_id
                FROM comments c
                LEFT JOIN tracks t ON c.track_id = t.id
                LEFT JOIN playlists p ON c.playlist_id = p.id
                WHERE c.id = $1
            `, [id]);

            if (result.rows.length === 0) {
                return res.status(404).json({ error: 'Comment not found' });
            }

            const comment = result.rows[0];

            // Allow deletion by comment author or entity owner
            const isCommentAuthor = comment.user_id === req.user.id;
            const isEntityOwner = comment.track_owner_id === req.user.id || 
                                  comment.playlist_owner_id === req.user.id;

            if (!isCommentAuthor && !isEntityOwner) {
                return res.status(403).json({ error: 'Access denied' });
            }

            await pool.query('DELETE FROM comments WHERE id = $1', [id]);

            res.json({ success: true });
        } catch (err) {
            logError('Delete comment error:', err);
            res.status(500).json({ error: 'Failed to delete comment' });
        }
    });

    return router;
};
