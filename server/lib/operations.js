'use strict';
async function operationalStatus(pool) {
    const { rows: [status] } = await pool.query(`SELECT
        (SELECT COUNT(*) FROM object_deletion_outbox WHERE processed_at IS NULL) AS pending_deletions,
        (SELECT COUNT(*) FROM object_deletion_outbox WHERE processed_at IS NULL AND attempts >= 3) AS failed_deletions,
        (SELECT COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0) FROM object_deletion_outbox WHERE processed_at IS NULL) AS oldest_deletion_seconds,
        (SELECT COUNT(*) FROM storage_objects WHERE state = 'STAGED' AND created_at < NOW() - ($2 * INTERVAL '1 minute')) AS stale_stages,
        (SELECT COUNT(*) FROM (SELECT owner_id FROM storage_objects WHERE state IN ('ACTIVE','STAGED')
            GROUP BY owner_id HAVING SUM(size_bytes) > $1) owners) AS over_quota_owners`,
    [Number(process.env.USER_STORAGE_QUOTA_BYTES || 21474836480), Number(process.env.OBJECT_STAGE_TTL_MINUTES || 60)]);
    const metrics = Object.fromEntries(Object.entries(status).map(([key, value]) => [key, Number(value)]));
    const alerts = [];
    if (metrics.failed_deletions > 0 || metrics.oldest_deletion_seconds > 3600) alerts.push('deletion_backlog');
    if (metrics.stale_stages > 0) alerts.push('stale_uploads');
    if (metrics.over_quota_owners > 0) alerts.push('quota_drift');
    return { metrics, alerts };
}
module.exports = { operationalStatus };
