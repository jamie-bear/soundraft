'use strict';
// Read-only recovery inventory. Never import index.js or bootstrap/migrate data.
const { Pool } = require('pg');
const { Client } = require('minio');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const endpoint = new URL(process.env.S3_ENDPOINT || 'http://storage:9000');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 });
const storage = new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port) || (endpoint.protocol === 'https:' ? 443 : 80),
    useSSL: endpoint.protocol === 'https:', accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY });
const bucket = process.env.S3_BUCKET || 'tracks';
const deadline = setTimeout(() => { console.error('Recovery verification timed out'); process.exit(1); }, Number(process.env.RECOVERY_VERIFY_TIMEOUT_MS || 3_600_000));
deadline.unref();
async function emit(value) {
    if (!process.stdout.write(`${JSON.stringify(value)}\n`)) await once(process.stdout, 'drain');
}
async function verify() {
    const counts = {};
    for (const table of ['users', 'tracks', 'track_versions', 'attachments', 'playlists', 'playlist_tracks', 'comments', 'reactions', 'system_settings', 'schema_migrations', 'storage_objects', 'object_deletion_outbox']) {
        counts[table] = (await pool.query(`SELECT COUNT(*)::text AS count FROM ${table}`)).rows[0].count;
    }
    await emit({ format: 1, counts });
    let cursor = '';
    while (true) {
        const { rows } = await pool.query(`SELECT * FROM (
            SELECT storage_key, size_bytes::text FROM track_versions
            UNION ALL SELECT storage_key, size_bytes::text FROM attachments
            UNION ALL SELECT substring(cover_art_path from 14), NULL::text FROM tracks WHERE cover_art_path IS NOT NULL
            UNION ALL SELECT substring(cover_art_path from 14), NULL::text FROM playlists WHERE cover_art_path IS NOT NULL
        ) objects WHERE storage_key > $1 ORDER BY storage_key LIMIT 100`, [cursor]);
        if (!rows.length) break;
        for (const row of rows) {
            const stat = await storage.statObject(bucket, row.storage_key);
            if (row.size_bytes !== null && BigInt(row.size_bytes) !== BigInt(stat.size)) throw new Error(`Size mismatch: ${row.storage_key}`);
            const stream = await storage.getObject(bucket, row.storage_key);
            const hash = createHash('sha256');
            let bytes = 0;
            for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
            if (bytes !== stat.size) throw new Error(`Truncated object: ${row.storage_key}`);
            await emit({ key: row.storage_key, bytes, sha256: hash.digest('hex') });
        }
        cursor = rows[rows.length - 1].storage_key;
    }
}
verify().catch(error => { console.error('Recovery verification failed:', error.message); process.exitCode = 1; })
    .finally(async () => { clearTimeout(deadline); await pool.end(); });
