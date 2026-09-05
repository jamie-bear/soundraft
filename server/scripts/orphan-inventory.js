'use strict';
// Default: read-only JSONL inventory. Quarantine copies never remove originals.
// Deletion consumes a reviewed quarantine receipt after a seven-day window.
const fs = require('node:fs');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const { Pool } = require('../lib/postgres');
const { Client } = require('minio');
const { storageTransport } = require('../lib/lifecycle');

async function hashFile(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
async function hashObject(storage, bucket, key) {
    const hash = createHash('sha256');
    for await (const chunk of await storage.getObject(bucket, key)) hash.update(chunk);
    return hash.digest('hex');
}
async function emit(row) { if (!process.stdout.write(JSON.stringify(row) + '\n')) await once(process.stdout, 'drain'); }

async function run() {
    const [mode = 'inventory', manifest, reviewedHash] = process.argv.slice(2);
    if (!['inventory', 'quarantine', 'delete'].includes(mode)) throw Error('Use inventory, quarantine MANIFEST SHA256, or delete RECEIPT SHA256');
    if (mode !== 'inventory' && (!manifest || !/^[a-f0-9]{64}$/.test(reviewedHash || '') || await hashFile(manifest) !== reviewedHash)) {
        throw Error('Mutation requires a reviewed manifest and its exact SHA256');
    }
    const endpoint = new URL(process.env.S3_ENDPOINT);
    const bucket = process.env.S3_BUCKET || 'tracks';
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, statement_timeout: 30_000 });
    const storage = new Client({ endPoint: endpoint.hostname, port: Number(endpoint.port) || (endpoint.protocol === 'https:' ? 443 : 80),
        useSSL: endpoint.protocol === 'https:', accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY,
        transport: storageTransport(endpoint.protocol === 'https:') });
    const unreferenced = async key => (await pool.query(`SELECT 1 FROM storage_objects WHERE storage_key=$1
        UNION ALL SELECT 1 FROM track_versions WHERE storage_key=$1
        UNION ALL SELECT 1 FROM attachments WHERE storage_key=$1
        UNION ALL SELECT 1 FROM tracks WHERE cover_art_path='/api/storage/'||$1
        UNION ALL SELECT 1 FROM playlists WHERE cover_art_path='/api/storage/'||$1`, [key])).rowCount === 0;
    try {
        if (mode === 'inventory') {
            for await (const object of storage.listObjectsV2(bucket, '', true)) {
                if (object.name.startsWith('_quarantine/') || !await unreferenced(object.name)) continue;
                await emit({ kind: 'orphan', bucket, key: object.name, size: object.size, etag: object.etag,
                    observed_at: new Date().toISOString() });
            }
            return;
        }
        const lines = readline.createInterface({ input: fs.createReadStream(manifest), crlfDelay: Infinity });
        for await (const line of lines) {
            const row = JSON.parse(line);
            if (row.bucket !== bucket || typeof row.key !== 'string' || !row.key || row.key.startsWith('_quarantine/')) throw Error('Invalid manifest scope');
            if (!await unreferenced(row.key)) throw Error('An inventoried object is now registered; refusing mutation');
            const stat = await storage.statObject(bucket, row.key);
            if (stat.etag !== row.etag || Number(stat.size) !== Number(row.size)) throw Error('Object changed since inventory');
            const digest = await hashObject(storage, bucket, row.key);
            const quarantineKey = `_quarantine/${createHash('sha256').update(row.key).digest('hex')}/${digest}`;
            if (mode === 'quarantine') {
                const source = await storage.getObject(bucket, row.key);
                await storage.putObject(bucket, quarantineKey, source, stat.size);
                if (await hashObject(storage, bucket, quarantineKey) !== digest) throw Error('Quarantine hash mismatch');
                await emit({ ...row, kind: 'quarantined', quarantine_key: quarantineKey, sha256: digest, quarantined_at: new Date().toISOString() });
            } else {
                if (row.kind !== 'quarantined' || row.quarantine_key !== quarantineKey || row.sha256 !== digest ||
                    !Number.isFinite(Date.parse(row.quarantined_at)) || Date.now() - Date.parse(row.quarantined_at) < 7 * 86400_000) throw Error('Verified quarantine must be retained for at least seven days');
                const quarantineStat = await storage.statObject(bucket, quarantineKey);
                if (Date.now() - new Date(quarantineStat.lastModified).getTime() < 7 * 86400_000) throw Error('Quarantine object is too recent');
                if (await hashObject(storage, bucket, quarantineKey) !== digest || !await unreferenced(row.key)) throw Error('Quarantine verification or reference recheck failed');
                const latest = await storage.statObject(bucket, row.key);
                if (latest.etag !== stat.etag) throw Error('Source changed during verification');
                await storage.removeObject(bucket, row.key);
                await emit({ kind: 'deleted', key: row.key, quarantine_key: quarantineKey });
            }
        }
    } finally { await pool.end(); }
}
if (require.main === module) run().catch(() => { console.error('Inventory operation failed; inspect the reviewed manifest and service health.'); process.exitCode = 1; });
module.exports = { hashFile, hashObject };
