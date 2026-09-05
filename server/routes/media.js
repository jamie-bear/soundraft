'use strict';
const { optionalAuth } = require('../middleware/auth');
const { streamUrl } = require('../lib/grants');
const { isUuid } = require('../lib/access');

module.exports = pool => {
    const router = require('../lib/router').createRouter();
    router.post('/renew', optionalAuth, async (req, res) => {
        const { versionId, share } = req.body;
        if (!isUuid(versionId) || (share && (!['track', 'playlist'].includes(share.type) || typeof share.token !== 'string' || share.token.length > 256))) {
            return res.status(400).json({ error: 'Invalid media request' });
        }
        const result = await pool.query(`SELECT t.id, t.owner_id, t.release_status, t.share_token
            FROM track_versions v JOIN tracks t ON t.id = v.track_id WHERE v.id = $1`, [versionId]);
        const track = result.rows[0];
        if (!track) return res.status(404).json({ error: 'This audio version is no longer available' });
        let allowed = req.user?.id === track.owner_id;
        if (share?.type === 'track') allowed ||= track.release_status === 'PUBLIC' && track.share_token === share.token;
        if (!allowed && share?.type === 'playlist') {
            const member = await pool.query(`SELECT 1 FROM playlists p JOIN playlist_tracks pt ON pt.playlist_id = p.id
                WHERE p.share_token = $1 AND p.is_public = true AND pt.track_id = $2`, [share.token, track.id]);
            allowed = member.rowCount > 0;
        }
        if (!allowed) return res.status(403).json({ error: 'Access to this audio has expired or was revoked. Open a current share link or sign in.' });
        res.set('Cache-Control', 'no-store').json({ stream_url: streamUrl(versionId) });
    });
    return router;
};
