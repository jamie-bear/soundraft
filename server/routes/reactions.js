const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Valid emoji types matching the 4 emojis from the spec
const VALID_EMOJI_TYPES = ['heart', 'fire', 'laugh', 'cry'];

const reactionLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many reactions. Please wait a moment.' },
});

module.exports = function(pool) {
    
    /**
     * GET /api/reactions/track/:trackId
     * Get reaction counts for a track
     * Also returns visitor's own reaction if visitorId provided
     */
    router.get('/track/:trackId', async (req, res) => {
        try {
            const { trackId } = req.params;
            const { visitorId } = req.query;

            // Get reaction counts by emoji type
            const countsResult = await pool.query(`
                SELECT emoji_type, COUNT(*) as count
                FROM reactions
                WHERE track_id = $1
                GROUP BY emoji_type
            `, [trackId]);

            // Build counts object
            const counts = {
                heart: 0,
                fire: 0,
                laugh: 0,
                cry: 0
            };
            
            for (const row of countsResult.rows) {
                counts[row.emoji_type] = parseInt(row.count);
            }

            // Get visitor's own reaction if visitorId provided
            let visitorReaction = null;
            if (visitorId) {
                const visitorResult = await pool.query(`
                    SELECT emoji_type FROM reactions
                    WHERE track_id = $1 AND visitor_id = $2
                `, [trackId, visitorId]);
                
                if (visitorResult.rows.length > 0) {
                    visitorReaction = visitorResult.rows[0].emoji_type;
                }
            }

            res.json({ counts, visitorReaction });
        } catch (err) {
            console.error('Get track reactions error:', err);
            res.status(500).json({ error: 'Failed to get reactions' });
        }
    });

    /**
     * GET /api/reactions/playlist/:playlistId
     * Get reaction counts for a playlist
     * Also returns visitor's own reaction if visitorId provided
     */
    router.get('/playlist/:playlistId', async (req, res) => {
        try {
            const { playlistId } = req.params;
            const { visitorId } = req.query;

            // Get reaction counts by emoji type
            const countsResult = await pool.query(`
                SELECT emoji_type, COUNT(*) as count
                FROM reactions
                WHERE playlist_id = $1
                GROUP BY emoji_type
            `, [playlistId]);

            // Build counts object
            const counts = {
                heart: 0,
                fire: 0,
                laugh: 0,
                cry: 0
            };
            
            for (const row of countsResult.rows) {
                counts[row.emoji_type] = parseInt(row.count);
            }

            // Get visitor's own reaction if visitorId provided
            let visitorReaction = null;
            if (visitorId) {
                const visitorResult = await pool.query(`
                    SELECT emoji_type FROM reactions
                    WHERE playlist_id = $1 AND visitor_id = $2
                `, [playlistId, visitorId]);
                
                if (visitorResult.rows.length > 0) {
                    visitorReaction = visitorResult.rows[0].emoji_type;
                }
            }

            res.json({ counts, visitorReaction });
        } catch (err) {
            console.error('Get playlist reactions error:', err);
            res.status(500).json({ error: 'Failed to get reactions' });
        }
    });

    /**
     * POST /api/reactions/track/:trackId
     * Add or update a reaction to a track
     * Body: { visitorId, emojiType }
     */
    router.post('/track/:trackId', reactionLimiter, async (req, res) => {
        try {
            const { trackId } = req.params;
            const { visitorId, emojiType } = req.body;

            if (!visitorId || !emojiType) {
                return res.status(400).json({ error: 'visitorId and emojiType are required' });
            }

            if (!VALID_EMOJI_TYPES.includes(emojiType)) {
                return res.status(400).json({ error: 'Invalid emoji type' });
            }

            // Verify track exists
            const track = await pool.query(
                'SELECT id FROM tracks WHERE id = $1',
                [trackId]
            );

            if (track.rows.length === 0) {
                return res.status(404).json({ error: 'Track not found' });
            }

            // Upsert reaction (insert or update if visitor already reacted)
            await pool.query(`
                INSERT INTO reactions (track_id, visitor_id, emoji_type)
                VALUES ($1, $2, $3)
                ON CONFLICT ON CONSTRAINT reactions_unique_track 
                DO UPDATE SET emoji_type = $3, created_at = CURRENT_TIMESTAMP
            `, [trackId, visitorId, emojiType]);

            res.json({ success: true, emojiType });
        } catch (err) {
            console.error('Add track reaction error:', err);
            res.status(500).json({ error: 'Failed to add reaction' });
        }
    });

    /**
     * POST /api/reactions/playlist/:playlistId
     * Add or update a reaction to a playlist
     * Body: { visitorId, emojiType }
     */
    router.post('/playlist/:playlistId', reactionLimiter, async (req, res) => {
        try {
            const { playlistId } = req.params;
            const { visitorId, emojiType } = req.body;

            if (!visitorId || !emojiType) {
                return res.status(400).json({ error: 'visitorId and emojiType are required' });
            }

            if (!VALID_EMOJI_TYPES.includes(emojiType)) {
                return res.status(400).json({ error: 'Invalid emoji type' });
            }

            // Verify playlist exists
            const playlist = await pool.query(
                'SELECT id FROM playlists WHERE id = $1',
                [playlistId]
            );

            if (playlist.rows.length === 0) {
                return res.status(404).json({ error: 'Playlist not found' });
            }

            // Upsert reaction (insert or update if visitor already reacted)
            await pool.query(`
                INSERT INTO reactions (playlist_id, visitor_id, emoji_type)
                VALUES ($1, $2, $3)
                ON CONFLICT ON CONSTRAINT reactions_unique_playlist 
                DO UPDATE SET emoji_type = $3, created_at = CURRENT_TIMESTAMP
            `, [playlistId, visitorId, emojiType]);

            res.json({ success: true, emojiType });
        } catch (err) {
            console.error('Add playlist reaction error:', err);
            res.status(500).json({ error: 'Failed to add reaction' });
        }
    });

    /**
     * DELETE /api/reactions/track/:trackId
     * Remove a visitor's reaction from a track
     * Body: { visitorId }
     */
    router.delete('/track/:trackId', async (req, res) => {
        try {
            const { trackId } = req.params;
            const { visitorId } = req.body;

            if (!visitorId) {
                return res.status(400).json({ error: 'visitorId is required' });
            }

            await pool.query(`
                DELETE FROM reactions
                WHERE track_id = $1 AND visitor_id = $2
            `, [trackId, visitorId]);

            res.json({ success: true });
        } catch (err) {
            console.error('Delete track reaction error:', err);
            res.status(500).json({ error: 'Failed to remove reaction' });
        }
    });

    /**
     * DELETE /api/reactions/playlist/:playlistId
     * Remove a visitor's reaction from a playlist
     * Body: { visitorId }
     */
    router.delete('/playlist/:playlistId', async (req, res) => {
        try {
            const { playlistId } = req.params;
            const { visitorId } = req.body;

            if (!visitorId) {
                return res.status(400).json({ error: 'visitorId is required' });
            }

            await pool.query(`
                DELETE FROM reactions
                WHERE playlist_id = $1 AND visitor_id = $2
            `, [playlistId, visitorId]);

            res.json({ success: true });
        } catch (err) {
            console.error('Delete playlist reaction error:', err);
            res.status(500).json({ error: 'Failed to remove reaction' });
        }
    });

    return router;
};
