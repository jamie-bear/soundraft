'use strict';
const fs = require('node:fs');
const path = require('node:path');

async function migrate(pool, directory, bucket) {
    const client = await pool.connect();
    try {
        // Session lock spans the ledger check and every transaction. Multiple
        // starting replicas must not race CREATE TABLE or apply the same file.
        await client.query("SELECT pg_advisory_lock(hashtext('soundraft:migrations'))");
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY, filename VARCHAR(255) UNIQUE NOT NULL,
            applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)`);
        for (const filename of fs.readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
            if ((await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [filename])).rows.length) continue;
            try {
                await client.query('BEGIN');
                await client.query("SELECT set_config('soundraft.bucket', $1, true)", [bucket]);
                await client.query(fs.readFileSync(path.join(directory, filename), 'utf8'));
                await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
                await client.query('COMMIT');
                console.log(`Migration applied: ${filename}`);
            } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
            }
        }
    } finally {
        try { await client.query("SELECT pg_advisory_unlock(hashtext('soundraft:migrations'))"); }
        finally { client.release(); }
    }
}
module.exports = { migrate };
