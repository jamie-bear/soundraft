const { logError } = require('./logging');
'use strict';

const DEFAULT_QUOTA = 20 * 1024 * 1024 * 1024;
const { assertRequestActive, context } = require('./lifecycle');

class StorageQuotaError extends Error {
    constructor() {
        super('Storage quota exceeded');
        this.statusCode = 413;
    }
}

async function stageStorageObject(pool, object) {
    assertRequestActive();
    const client = await pool.connect();
    const quotaBytes = Number(object.quotaBytes || process.env.USER_STORAGE_QUOTA_BYTES || DEFAULT_QUOTA);
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [object.ownerId]);
        const usage = await client.query(
            "SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM storage_objects WHERE owner_id = $1 AND state IN ('STAGED', 'ACTIVE')",
            [object.ownerId]
        );
        if (Number(usage.rows[0].bytes) + Number(object.sizeBytes) > quotaBytes) {
            throw new StorageQuotaError();
        }
        await client.query(`
            INSERT INTO storage_objects
                (storage_key, bucket, owner_id, state, size_bytes, mime_type)
            VALUES ($1, $2, $3, 'STAGED', $4, $5)
        `, [object.storageKey, object.bucket, object.ownerId, object.sizeBytes, object.mimeType || null]);
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function activateStorageObject(client, storageKey, resourceType, resourceId) {
    assertRequestActive();
    const result = await client.query(`
        UPDATE storage_objects
        SET state = 'ACTIVE', resource_type = $2, resource_id = $3,
            activated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE storage_key = $1 AND state = 'STAGED'
    `, [storageKey, resourceType, resourceId]);
    if (result.rowCount !== 1) {
        const error = new Error('Upload expired before it could be saved; please retry');
        error.statusCode = 409;
        throw error;
    }
}

async function abandonStorageObject(pool, storageKey, bucket) {
    if (!storageKey) return;
    // Never delete an ACTIVE object after an ambiguous COMMIT or response failure.
    await pool.query(`SELECT enqueue_storage_deletion(storage_key, bucket)
        FROM storage_objects WHERE storage_key = $1 AND state = 'STAGED' FOR UPDATE`, [storageKey]);
}

function createObjectReconciler(pool, minioClient, options = {}) {
    const intervalMs = Number(options.intervalMs || 30_000);
    const batchSize = Number(options.batchSize || 20);
    const stageTtlMinutes = Number(options.stageTtlMinutes || 60);
    let timer;
    let running = false;
    let controller;

    async function finish(id, storageKey) {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`
                UPDATE object_deletion_outbox
                SET processed_at = CURRENT_TIMESTAMP, locked_at = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [id]);
            await client.query(`
                UPDATE storage_objects SET state = 'DELETED', updated_at = CURRENT_TIMESTAMP
                WHERE storage_key = $1
            `, [storageKey]);
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    async function retry(id, error) {
        await pool.query(`
            UPDATE object_deletion_outbox
            SET locked_at = NULL, last_error = $2,
                next_attempt_at = CURRENT_TIMESTAMP + LEAST(INTERVAL '1 hour', INTERVAL '5 seconds' * power(2, LEAST(attempts, 10))),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [id, String(error.code || 'STORAGE_DELETE_FAILED').slice(0, 80)]);
    }

    async function performRun() {
        if (running) return;
        running = true;
        let guard;
        try {
            guard = await pool.connect();
            // Session lock survives time spent streaming objects between queries.
            const lock = await guard.query("SELECT pg_try_advisory_lock(hashtext('soundraft:exports')) AS acquired");
            if (!lock.rows[0].acquired) return;
            // Old cover records were backfilled without a known size. Repair in
            // bounded batches so quotas/admin usage eventually include them.
            const legacy = await pool.query(`SELECT storage_key, bucket FROM storage_objects
                WHERE state = 'ACTIVE' AND size_bytes = 0 AND resource_type IN ('TRACK_COVER', 'PLAYLIST_COVER')
                ORDER BY updated_at, storage_key LIMIT $1`, [batchSize]);
            for (const object of legacy.rows) {
                try {
                    const stat = await minioClient.statObject(object.bucket, object.storage_key);
                    await pool.query(`UPDATE storage_objects SET size_bytes = $2, updated_at = CURRENT_TIMESTAMP
                        WHERE storage_key = $1 AND state = 'ACTIVE' AND size_bytes = 0`, [object.storage_key, stat.size]);
                } catch (error) {
                    // Rotate failures to the back of the batch, without deleting
                    // a referenced object or starving later legacy records.
                    await pool.query('UPDATE storage_objects SET updated_at = CURRENT_TIMESTAMP WHERE storage_key = $1', [object.storage_key]);
                    logError('Legacy object size check failed:', error);
                }
            }
            await pool.query(`
                WITH candidates AS MATERIALIZED (
                    SELECT storage_key, bucket FROM storage_objects
                    WHERE state = 'STAGED'
                      AND created_at < CURRENT_TIMESTAMP - ($1 * INTERVAL '1 minute')
                    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
                ) SELECT enqueue_storage_deletion(storage_key, bucket) FROM candidates
            `, [stageTtlMinutes, batchSize]);
            const claimed = await pool.query(`
                UPDATE object_deletion_outbox o
                SET locked_at = CURRENT_TIMESTAMP, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
                WHERE o.id IN (
                    SELECT id FROM object_deletion_outbox
                    WHERE processed_at IS NULL
                      AND next_attempt_at <= CURRENT_TIMESTAMP
                      AND (locked_at IS NULL OR locked_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
                    ORDER BY next_attempt_at, id
                    FOR UPDATE SKIP LOCKED LIMIT $1
                )
                RETURNING id, storage_key, bucket
            `, [batchSize]);
            const outcomes = await Promise.allSettled(claimed.rows.map(async (row) => {
                try {
                    await minioClient.removeObject(row.bucket, row.storage_key);
                    await finish(row.id, row.storage_key);
                } catch (error) {
                    if (error.code === 'NoSuchKey' || error.code === 'NotFound') {
                        await finish(row.id, row.storage_key);
                    } else {
                        await retry(row.id, error);
                    }
                }
            }));
            const failure = outcomes.find(result => result.status === 'rejected');
            if (failure) throw failure.reason;
        } finally {
            if (guard) { await guard.query("SELECT pg_advisory_unlock(hashtext('soundraft:exports'))").catch(() => {}); guard.release(); }
            running = false;
        }
    }

    function runOnce() {
        if (running) return Promise.resolve();
        controller = new AbortController();
        return context.run({ controller }, performRun);
    }
    return {
        runOnce,
        start() {
            if (timer) return;
            runOnce().catch((error) => logError('Object reconciliation error:', error));
            timer = setInterval(() => runOnce().catch((error) => logError('Object reconciliation error:', error)), intervalMs);
            timer.unref?.();
        },
        async stop() {
            clearInterval(timer); timer = undefined;
            controller?.abort();
            while (running) await new Promise(resolve => setTimeout(resolve, 20));
        },
    };
}

module.exports = {
    StorageQuotaError,
    abandonStorageObject,
    activateStorageObject,
    createObjectReconciler,
    stageStorageObject,
};
