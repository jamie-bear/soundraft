'use strict';
// Destructive fixture helper: only the isolated gate database/bucket is allowed.
const assert = require('node:assert/strict');
assert.equal(new URL(process.env.DATABASE_URL).pathname, '/gate_catalog');
assert.equal(process.env.S3_BUCKET, 'gate-media');
const { pool, minioClient, BUCKET_NAME } = require('../index');
(async () => {
    const { rows } = await pool.query('SELECT storage_key FROM track_versions ORDER BY id LIMIT 1');
    assert.equal(rows.length, 1);
    await minioClient.removeObject(BUCKET_NAME, rows[0].storage_key);
})().catch(() => { console.error('Fixture object removal failed'); process.exitCode = 1; }).finally(() => pool.end());
