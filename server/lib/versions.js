'use strict';

function failure(statusCode, message) { return Object.assign(new Error(message), { statusCode }); }

async function mutateVersion(pool, ownerId, trackId, versionId, operation) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Use the same lock as version uploads; keep checks and mutation atomic.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [trackId]);
        const track = (await client.query('SELECT * FROM tracks WHERE id = $1 FOR UPDATE', [trackId])).rows[0];
        if (!track) throw failure(404, 'Track not found');
        if (track.owner_id !== ownerId) throw failure(403, 'Access denied');
        const versions = (await client.query('SELECT id FROM track_versions WHERE track_id = $1 ORDER BY version_number DESC', [trackId])).rows;
        if (!versions.some(row => row.id === versionId)) throw failure(404, 'Version not found');
        if (operation === 'delete' && versions.length <= 1) throw failure(400, 'Cannot delete the only version');
        let result = track;
        if (operation === 'activate' || track.current_version_id === versionId) {
            const nextId = operation === 'activate' ? versionId : versions.find(row => row.id !== versionId).id;
            result = (await client.query(`UPDATE tracks SET current_version_id = $1, updated_at = CURRENT_TIMESTAMP
                WHERE id = $2 RETURNING *`, [nextId, trackId])).rows[0];
        }
        if (operation === 'delete') await client.query('DELETE FROM track_versions WHERE id = $1 AND track_id = $2', [versionId, trackId]);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
    } finally { client.release(); }
}
module.exports = { mutateVersion };
