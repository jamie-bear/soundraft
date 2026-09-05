'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

function wav() {
    const buffer = Buffer.alloc(44 + 16000);
    buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
    buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36); buffer.writeUInt32LE(16000, 40); return buffer;
}

exports.run = async function() {
    const url = new URL(process.env.TEST_DATABASE_URL);
    if (url.pathname !== '/soundraft_test') throw Error('Integration tests require a fresh database named soundraft_test; existing databases are never reset');
    Object.assign(process.env, { DATABASE_URL: process.env.TEST_DATABASE_URL,
        JWT_SECRET: 'integration-only-secret-at-least-thirty-two-characters',
        S3_ENDPOINT: process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:9000', S3_ACCESS_KEY: process.env.TEST_S3_ACCESS_KEY || 'integration-key', S3_SECRET_KEY: process.env.TEST_S3_SECRET_KEY || 'integration-secret-only',
        S3_BUCKET: 'custom-integration-bucket', ADMIN_EMAIL: 'test@example.com', ADMIN_PASSWORD: 'test-only-admin-password' });
    const { app, pool, minioClient, BUCKET_NAME } = require('../index');
    const { generateToken } = require('../middleware/auth');
    const { migrate } = require('../lib/migrations');
    const { stageStorageObject, abandonStorageObject, activateStorageObject, createObjectReconciler } = require('../lib/object-lifecycle');
    const objects = new Map();
    const realStorage = process.env.TEST_REAL_STORAGE === 'true';
    const real = Object.fromEntries(['fPutObject','statObject','getObject','getPartialObject','removeObject'].map(name => [name, minioClient[name].bind(minioClient)]));
    if (realStorage) {
        assert.equal(await minioClient.bucketExists(BUCKET_NAME), false, 'Refusing to use an existing real-service test bucket');
        await minioClient.makeBucket(BUCKET_NAME);
    }
    // PostgreSQL and HTTP are real; only the object transport is deterministic.
    minioClient.fPutObject = async (bucket, key, filename) => { assert.equal(bucket, BUCKET_NAME); objects.set(key, await fs.promises.readFile(filename)); if (realStorage) await real.fPutObject(bucket, key, filename); };
    minioClient.statObject = async (bucket, key) => {
        assert.equal(bucket, BUCKET_NAME);
        if (!objects.has(key)) throw Object.assign(Error('Not found'), { code: 'NoSuchKey' });
        return realStorage ? real.statObject(bucket, key) : { size: objects.get(key).length, metaData: {} };
    };
    minioClient.getObject = async (bucket, key) => { await minioClient.statObject(bucket, key); return realStorage ? real.getObject(bucket, key) : Readable.from([objects.get(key)]); };
    minioClient.getPartialObject = async (bucket, key, start, length) => { await minioClient.statObject(bucket, key); return realStorage ? real.getPartialObject(bucket, key, start, length) : Readable.from([objects.get(key).subarray(start, start + length)]); };
    minioClient.removeObject = async (bucket, key) => { assert.equal(bucket, BUCKET_NAME); objects.delete(key); if (realStorage) await real.removeObject(bucket, key); };
    let server;
    try {
        const tables = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = 'public'");
        assert.equal(tables.rows.length, 0, 'Refusing to use a nonempty integration database');
        await pool.query(fs.readFileSync(path.join(__dirname, '../db/init.sql'), 'utf8'));
        const user = (await pool.query("INSERT INTO users(email, password_hash) VALUES ('owner@example.com','test') RETURNING *")).rows[0];
        const legacy = (await pool.query("INSERT INTO tracks(owner_id,title) VALUES ($1,'Legacy') RETURNING id", [user.id])).rows[0];
        for (const n of [7, 9]) await pool.query(`INSERT INTO track_versions(track_id,version_number,filename,storage_key,mime_type,size_bytes)
            VALUES ($1,$2,'legacy.wav',$3,'audio/wav',4)`, [legacy.id, n, `legacy-${n}`]);
        const directory = path.join(__dirname, '../db/migrations');
        await Promise.all([migrate(pool, directory, BUCKET_NAME), migrate(pool, directory, BUCKET_NAME)]);
        await migrate(pool, directory, BUCKET_NAME);
        assert.equal((await pool.query('SELECT * FROM schema_migrations')).rowCount, fs.readdirSync(directory).filter(n => n.endsWith('.sql')).length);
        assert.deepEqual((await pool.query('SELECT version_number FROM track_versions ORDER BY version_number')).rows.map(r => r.version_number), [7, 9]);
        assert.ok((await pool.query('SELECT bucket FROM storage_objects')).rows.every(r => r.bucket === BUCKET_NAME));
        console.log('PASS: concurrent migrations, idempotence, legacy numbering and custom bucket backfill');

        user.auth_version = 1;
        const token = generateToken(user);
        server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        async function api(route, method = 'GET', body, authenticated = true) {
            const headers = authenticated ? { Authorization: `Bearer ${token}` } : {};
            if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
            return fetch(base + route, { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
        }
        let response = await api('/api/tracks', 'POST', { title: 'New', artist: 'Artist' });
        assert.equal(response.status, 201); const track = (await response.json()).track;
        response = await api(`/api/tracks/${track.id}`, 'PUT', { artist: '' });
        assert.equal(response.status, 200); assert.equal((await response.json()).track.artist, null);
        assert.equal((await api(`/api/tracks/${track.id}`, 'PUT', { title: '<b></b>' })).status, 400);
        async function upload() {
            const form = new FormData(); form.append('audio', new Blob([wav()], { type: 'audio/wav' }), 'test.wav');
            const result = await api(`/api/tracks/${track.id}/versions`, 'POST', form);
            const body = await result.json(); assert.equal(result.status, 201, JSON.stringify(body)); return body.version;
        }
        const versions = await Promise.all([upload(), upload()]);
        assert.equal(new Set(versions.map(v => v.version_number)).size, 2);
        assert.equal(new Set(versions.map(v => v.storage_key)).size, 2);
        response = await fetch(base + versions[0].stream_url, { headers: { Range: 'bytes=0-3' } });
        assert.equal(response.status, 206); assert.equal(await response.text(), 'RIFF');
        response = await fetch(base + versions[0].stream_url, { headers: { Range: 'bytes=-' } }); assert.equal(response.status, 416);
        console.log('PASS: metadata editing, concurrent uploads, exact range playback and malformed ranges');

        const playlist = (await (await api('/api/playlists', 'POST', { title: 'Shared playlist' })).json()).playlist;
        assert.equal((await api(`/api/playlists/${playlist.id}/tracks/batch`, 'POST', { trackIds: [track.id] })).status, 201);
        await api(`/api/playlists/${playlist.id}`, 'PUT', { is_public: true });
        response = await api(`/api/playlists/${playlist.id}?token=${playlist.share_token}`, 'GET', undefined, false);
        assert.equal(response.status, 200); const shared = await response.json();
        assert.equal((await fetch(base + shared.tracks[0].stream_url)).status, 200);
        assert.equal((await api(`/api/tracks/${track.id}`, 'GET', undefined, false)).status, 401);
        console.log('PASS: anonymous playlist playback without making its underlying private track public');
        const visitorUser = (await pool.query("INSERT INTO users(email,password_hash) VALUES ('visitor@example.com','test') RETURNING *")).rows[0];
        const visitorToken = generateToken(visitorUser);
        assert.equal((await fetch(base + `/api/tracks/${track.id}`, { headers: { Authorization: `Bearer ${visitorToken}` } })).status, 403);
        assert.equal((await fetch(base + '/api/media/renew', { method: 'POST', headers: { Authorization: `Bearer ${visitorToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ versionId: versions[0].id }) })).status, 403);


        const renewal = await api('/api/media/renew', 'POST', { versionId: versions[0].id,
            share: { type: 'playlist', token: playlist.share_token } }, false);
        assert.equal(renewal.status, 200);
        await api(`/api/playlists/${playlist.id}`, 'PUT', { is_public: false });
        assert.equal((await api('/api/media/renew', 'POST', { versionId: versions[0].id,
            share: { type: 'playlist', token: playlist.share_token } }, false)).status, 403);
        assert.equal((await api('/api/media/renew', 'POST', { versionId: versions[0].id })).status, 200);
        const listed = await (await api('/api/tracks?limit=1&search=New')).json();
        assert.equal(listed.tracks.length, 1); assert.equal(listed.tracks[0].id, track.id);
        assert.equal((await api('/api/tracks?sort=invalid')).status, 400);
        await api(`/api/playlists/${playlist.id}/tracks`, 'POST', { trackId: legacy.id });
        const playlistPage = await (await api(`/api/playlists/${playlist.id}?limit=1`)).json();
        assert.equal(playlistPage.tracks.length, 1); assert.ok(playlistPage.next_cursor);
        const playlistPage2 = await (await api(`/api/playlists/${playlist.id}?limit=1&cursor=${playlistPage.next_cursor}`)).json();
        assert.notEqual(playlistPage.tracks[0].id, playlistPage2.tracks[0].id);
        const beforeReorder = (await pool.query('SELECT revision FROM playlists WHERE id=$1', [playlist.id])).rows[0].revision;
        assert.equal((await api(`/api/playlists/${playlist.id}/reorder`, 'PUT', { trackIds: [legacy.id, track.id] })).status, 200);
        const afterReorder = (await pool.query('SELECT revision FROM playlists WHERE id=$1', [playlist.id])).rows[0].revision;
        assert.equal(BigInt(afterReorder)-BigInt(beforeReorder), 1n, 'Bulk reorder increments the revision once per statement');
        await api(`/api/playlists/${playlist.id}/tracks/${legacy.id}`, 'DELETE');
        assert.equal((await api(`/api/playlists/${playlist.id}?cursor=${playlistPage.next_cursor}`)).status, 409);
        for (let n = 0; n < 205; n++) assert.equal((await fetch(base + '/api/live')).status, 200);
        console.log('PASS: authorized renewal, revoked share denial, bounded search, playlist revision cursors, unlimited liveness');

        const deleted = await Promise.all(versions.map(v => api(`/api/tracks/${track.id}/versions/${v.id}`, 'DELETE')));
        assert.deepEqual(deleted.map(r => r.status).sort(), [200, 400]);
        const remaining = (await pool.query('SELECT * FROM track_versions WHERE track_id=$1', [track.id])).rows;
        assert.equal(remaining.length, 1);
        assert.equal((await pool.query('SELECT current_version_id FROM tracks WHERE id=$1', [track.id])).rows[0].current_version_id, remaining[0].id);
        await abandonStorageObject(pool, remaining[0].storage_key, BUCKET_NAME);
        await pool.query('SELECT enqueue_storage_deletion($1, $2)', [remaining[0].storage_key, BUCKET_NAME]);
        assert.equal((await pool.query('SELECT * FROM object_deletion_outbox WHERE storage_key=$1', [remaining[0].storage_key])).rowCount, 0);
        console.log('PASS: concurrent deletion retains the last version; committed objects cannot be abandoned');

        await stageStorageObject(pool, { storageKey: 'expired-object', bucket: BUCKET_NAME, ownerId: user.id, sizeBytes: 1 });
        await pool.query("UPDATE storage_objects SET created_at=NOW()-INTERVAL '2 hours' WHERE storage_key='expired-object'");
        objects.set('expired-object', Buffer.from('x'));
        if (realStorage) await minioClient.putObject(BUCKET_NAME, 'expired-object', Buffer.from('x'));
        const reconciler = createObjectReconciler(pool, minioClient);
        await reconciler.runOnce();
        await assert.rejects(activateStorageObject(pool, 'expired-object', 'TRACK_VERSION', remaining[0].id), { statusCode: 409 });
        assert.equal(objects.has('expired-object'), false);
        assert.equal(objects.has(remaining[0].storage_key), true);
        console.log('PASS: stale staging is reclaimed, late activation rejected and live objects retained');

        const normalPut = minioClient.fPutObject;
        let releasePut, enteredPut;
        const putEntered = new Promise(resolve => { enteredPut = resolve; });
        const putWait = new Promise(resolve => { releasePut = resolve; });
        minioClient.fPutObject = async (...args) => { enteredPut(); await putWait; return normalPut(...args); };
        const cancel = new AbortController();
        const cancelledForm = new FormData(); cancelledForm.append('audio', new Blob([wav()], { type: 'audio/wav' }), 'cancelled.wav');
        const cancelledUpload = fetch(base + `/api/tracks/${track.id}/versions`, { method: 'POST',
            headers: { Authorization: `Bearer ${token}` }, body: cancelledForm, signal: cancel.signal }).catch(() => null);
        await putEntered; cancel.abort(); await cancelledUpload;
        await new Promise(resolve => setTimeout(resolve, 25)); releasePut();
        await new Promise(resolve => setTimeout(resolve, 100));
        minioClient.fPutObject = normalPut;
        assert.equal((await pool.query('SELECT id FROM track_versions WHERE track_id=$1', [track.id])).rowCount, 1);
        console.log('PASS: cancellation during storage upload does not activate an audio version');

        const quotaUser = (await pool.query("INSERT INTO users(email,password_hash) VALUES ('quota@example.com','test') RETURNING id")).rows[0];
        const reservations = await Promise.allSettled(['quota-a', 'quota-b'].map(storageKey => stageStorageObject(pool, {
            storageKey, bucket: BUCKET_NAME, ownerId: quotaUser.id, sizeBytes: 100, quotaBytes: 150,
        })));
        assert.equal(reservations.filter(r => r.status === 'fulfilled').length, 1);
        console.log('PASS: concurrent quota reservations cannot exceed the user limit');

        await pool.query("UPDATE tracks SET release_status='PUBLIC',comment_access='PUBLIC_FULL',share_token='test-share' WHERE id=$1", [track.id]);
        for (const fraction of ['123456','123457']) await pool.query(`INSERT INTO comments(track_id,user_id,body,audio_timestamp,created_at)
            VALUES ($1,$2,$3,0,$4)`, [track.id, user.id, fraction, `2026-09-05T00:00:00.${fraction}Z`]);
        const first = await (await api(`/api/comments/track/${track.id}?limit=1`)).json();
        const second = await (await api(`/api/comments/track/${track.id}?limit=1&cursor=${first.next_cursor}`)).json();
        assert.notEqual(first.comments[0].id, second.comments[0].id); assert.equal(second.next_cursor, null);
        assert.equal(second.comments[0].audio_timestamp, 0);
        console.log('PASS: microsecond pagination has no skipped/repeated comments and preserves timestamp zero');

        const attachmentForm = new FormData(); attachmentForm.append('file', new Blob(['private notes']), 'résumé.txt');
        const attachment = await (await api(`/api/attachments/track/${track.id}`, 'POST', attachmentForm)).json();
        const grant = await (await api(`/api/attachments/${attachment.attachment.id}/download-grant`, 'POST')).json();
        assert.equal(await (await fetch(base + grant.url)).text(), 'private notes');
        const sharp = require('sharp');
        const cover = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#123456' } }).png().toBuffer();
        const coverForm = new FormData(); coverForm.append('cover', new Blob([cover], { type: 'image/png' }), 'cover.png');
        response = await api(`/api/tracks/${track.id}/cover`, 'POST', coverForm);
        assert.equal(response.status, 200); const covered = (await response.json()).track;
        assert.equal((await fetch(base + covered.cover_art_path)).status, 200);
        await pool.query("UPDATE users SET role='ADMIN' WHERE id=$1", [user.id]);
        const stats = await (await api(`/api/admin/users/${user.id}`)).json();
        const bytes = (await pool.query("SELECT SUM(size_bytes) AS bytes FROM storage_objects WHERE owner_id=$1 AND state='ACTIVE'", [user.id])).rows[0].bytes;
        assert.equal(stats.user.total_storage_bytes, bytes);
        assert.ok(Number(bytes) > wav().length + 'private notes'.length + 8);
        console.log('PASS: real cover processing and admin totals include audio, attachments and covers without join multiplication');
        if (process.env.RUN_BENCHMARK === 'true') await require('./benchmark').run({ pool, base, api, userId: user.id, trackId: track.id });
        await pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [user.id]);
        assert.equal((await fetch(base + grant.url)).status, 403);
        assert.equal((await api('/api/tracks')).status, 401);
        console.log('PASS: disk attachments download correctly and session/download grants revoke immediately');
        await pool.query('DELETE FROM users WHERE id=$1', [user.id]);
        const exportGuard = await pool.connect();
        await exportGuard.query('BEGIN');
        await exportGuard.query("SELECT pg_advisory_xact_lock_shared(hashtext('soundraft:exports'))");
        await reconciler.runOnce();
        assert.equal(objects.has(remaining[0].storage_key), true, 'Export retains objects after metadata deletion');
        await exportGuard.query('ROLLBACK'); exportGuard.release();
        const queued = await pool.query('SELECT * FROM object_deletion_outbox WHERE processed_at IS NULL');
        assert.ok(queued.rowCount >= 3);
        assert.ok(queued.rows.every(r => r.bucket === BUCKET_NAME));
        const failing = createObjectReconciler(pool, { ...minioClient, removeObject: async () => { throw Error('offline'); } });
        await failing.runOnce();
        assert.ok((await pool.query('SELECT attempts,last_error FROM object_deletion_outbox WHERE processed_at IS NULL')).rows.every(r => r.attempts >= 1 && r.last_error));
        await pool.query('UPDATE object_deletion_outbox SET attempts=3 WHERE processed_at IS NULL');
        const operations = await require('../lib/operations').operationalStatus(pool);
        assert.ok(operations.alerts.includes('deletion_backlog'));
        await pool.query('UPDATE object_deletion_outbox SET next_attempt_at=NOW()');
        await reconciler.runOnce();
        assert.equal((await pool.query('SELECT * FROM object_deletion_outbox WHERE processed_at IS NULL')).rowCount, 0);
        console.log('PASS: user cascades enqueue all objects in the correct bucket; failed deletions retry successfully');
        if (realStorage) {
            const { promisify } = require('node:util');
            const execFile = promisify(require('node:child_process').execFile);
            const os = require('node:os');
            const { createHash } = require('node:crypto');
            const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soundraft-inventory-test-'));
            try {
                await minioClient.putObject(BUCKET_NAME, 'historical-orphan', Buffer.from('orphan recovery fixture'));
                const script = path.join(__dirname, '../scripts/orphan-inventory.js');
                const { stdout: inventory } = await execFile(process.execPath, [script]);
                assert.ok(inventory.includes('historical-orphan'));
                assert.equal((await real.statObject(BUCKET_NAME, 'historical-orphan')).size, 23);
                const manifest = path.join(directory, 'inventory.jsonl');
                await fs.promises.writeFile(manifest, inventory);
                await assert.rejects(execFile(process.execPath, [script, 'quarantine', manifest, '0'.repeat(64)]));
                const { stdout: receipt } = await execFile(process.execPath, [script, 'quarantine', manifest, createHash('sha256').update(inventory).digest('hex')]);
                await fs.promises.writeFile(manifest, receipt);
                await assert.rejects(execFile(process.execPath, [script, 'delete', manifest, createHash('sha256').update(receipt).digest('hex')]));
                assert.equal((await real.statObject(BUCKET_NAME, 'historical-orphan')).size, 23);
                console.log('PASS: read-only orphan inventory, reviewed quarantine and deletion recovery window');
            } finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
        }

    } finally {
        if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
        if (realStorage) {
            for await (const object of minioClient.listObjectsV2(BUCKET_NAME, '', true)) await real.removeObject(BUCKET_NAME, object.name);
            await minioClient.removeBucket(BUCKET_NAME);
        }
        await pool.end();
    }
};
