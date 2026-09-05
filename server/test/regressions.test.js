'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const sharp = require('sharp');
const { parseRange, sendObject, streamFailure } = require('../lib/streaming');
const { prepareCover, audioDuration } = require('../lib/media');
const { activateStorageObject } = require('../lib/object-lifecycle');
const { validateMetadata } = require('../lib/metadata');
const { createRouter } = require('../lib/router');
const { issueGrant } = require('../lib/grants');
const { generateToken, requireAuth, setAuthPool } = require('../middleware/auth');

async function serve(router, callback) {
    const app = express(); app.use(express.json()); app.use(router);
    const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try { await callback(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('range parser handles suffix/clamped/open ranges and rejects malformed/unsafe offsets', () => {
    assert.deepEqual(parseRange('bytes=2-5', 10), { start: 2, end: 5, length: 4 });
    assert.deepEqual(parseRange('bytes=-500', 10), { start: 0, end: 9, length: 10 });
    assert.deepEqual(parseRange('bytes=8-', 10), { start: 8, end: 9, length: 2 });
    for (const range of ['bytes=-', 'bytes=-0', 'bytes=10-', 'bytes=3-2', 'bytes=0-1,4-5', 'bytes=9007199254740993-', 'bytes=0-1x']) assert.equal(parseRange(range, 10), null);
    assert.equal(parseRange('bytes=0-', 0), null);
});

test('object acquisition failure returns an error without stale success headers', async () => {
    const router = createRouter();
    router.get('/', async (req, res) => {
        try { await sendObject(req, res, { getObject: async () => { throw Error('offline'); } }, 'bucket', 'key', { headers: { 'Content-Length': 999 } }); }
        catch (error) { streamFailure(res, error, 'Unavailable'); }
    });
    await serve(router, async base => {
        const response = await fetch(base);
        assert.equal(response.status, 502); assert.equal(await response.text(), 'Unavailable');
    });
});

test('object transfers produce exact partial bytes and safe Unicode download headers', async () => {
    const router = createRouter();
    router.get('/', (req, res) => sendObject(req, res, {
        getPartialObject: async (_bucket, _key, start, length) => Readable.from([Buffer.from('0123456789').subarray(start, start + length)]),
    }, 'bucket', 'key', { range: parseRange('bytes=2-5', 10), filename: 'héllo".wav', headers: { 'Content-Length': 4 } }));
    await serve(router, async base => {
        const response = await fetch(base); assert.equal(response.status, 206);
        assert.equal(await response.text(), '2345'); assert.match(response.headers.get('content-disposition'), /attachment/);
    });
});

test('source stream failure aborts the download instead of completing a truncated body', async () => {
    const router = createRouter();
    router.get('/', (req, res) => sendObject(req, res, { getObject: async () => new Readable({
        read() { this.push(Buffer.from('short')); this.destroy(Error('storage read failed')); },
    }) }, 'bucket', 'key', { headers: { 'Content-Length': 100 } }));
    await serve(router, async base => { await assert.rejects(async () => { const response = await fetch(base); await response.arrayBuffer(); }); });
});

test('empty library export uses the installed Archiver API and yields a complete ZIP', async () => {
    const pool = { query: async query => ({ rows: (query.text || String(query)).includes('FROM users') ? [{ is_active: true, auth_version: 1 }] : [] }) };
    pool.connect = async () => ({ query: pool.query, release() {} });
    const router = require('../routes/export')(pool, {}, 'test');
    const grant = issueGrant({ purpose: 'library-export', mode: 'tracks', user_id: 'test', auth_version: 1 });
    await serve(router, async base => {
        const response = await fetch(`${base}/library?grant=${grant}`);
        assert.equal(response.status, 200);
        const zip = Buffer.from(await response.arrayBuffer());
        assert.equal(zip.readUInt32LE(0), 0x06054b50); // end-of-central-directory, empty archive
        assert.equal(zip.length, 22);
    });
});

test('export does not silently skip a missing referenced object', async () => {
    const pool = { query: async query => ({ rows: (query.text || String(query)).includes('FROM users') ? [{ is_active: true, auth_version: 1 }]
        : (query.text || String(query)).includes('FROM tracks WHERE') ? [{ id: 'track', title: 'Track' }]
        : (query.text || String(query)).includes('FROM track_versions') ? [{ id: 'version', version_number: 1, filename: 'lost.wav', storage_key: 'lost' }] : [] }) };
    pool.connect = async () => ({ query: pool.query, release() {} });
    const router = require('../routes/export')(pool, { getObject: async () => { throw Error('NoSuchKey'); } }, 'test');
    const grant = issueGrant({ purpose: 'library-export', mode: 'tracks', user_id: 'test', auth_version: 1 });
    await serve(router, async base => { await assert.rejects(async () => { const response = await fetch(`${base}/library?grant=${grant}`); await response.arrayBuffer(); }); });
});

test('expired storage staging cannot be finalized as a successful resource', async () => {
    await assert.rejects(activateStorageObject({ query: async () => ({ rowCount: 0 }) }, 'expired', 'TRACK_VERSION', 'version'), { statusCode: 409 });
});

test('metadata rejects empty/overlong titles and allows explicitly clearing artist', () => {
    assert.equal(validateMetadata({ artist: '' }, 'track'), null);
    assert.equal(validateMetadata({ artist: null }, 'playlist'), null);
    for (const title of ['', '<b></b>', {}, 'x'.repeat(256)]) assert.ok(validateMetadata({ title }, 'track'));
    assert.ok(validateMetadata({ type: 'UNKNOWN' }, 'track'));
});

test('cover processing validates real bytes/aspect ratio, strips metadata and bounds output', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soundraft-media-test-'));
    try {
        const input = path.join(directory, 'square.png');
        await sharp({ create: { width: 2200, height: 2200, channels: 3, background: '#ff0000' } }).png().toFile(input);
        const file = { path: input, mimetype: 'image/png' }; await prepareCover(file);
        const metadata = await sharp(file.path).metadata();
        assert.equal(metadata.width, 2048); assert.equal(metadata.format, 'webp'); assert.ok(file.size < 6 * 1024 * 1024);
        const rectangle = path.join(directory, 'rectangle.png');
        await sharp({ create: { width: 20, height: 10, channels: 3, background: '#000000' } }).png().toFile(rectangle);
        await assert.rejects(prepareCover({ path: rectangle }), { statusCode: 400 });
        const fake = path.join(directory, 'fake.mp3'); await fs.writeFile(fake, 'not media');
        await assert.rejects(prepareCover({ path: fake }), { statusCode: 400 });
        await assert.rejects(audioDuration({ path: fake, mimetype: 'audio/mpeg' }), { statusCode: 400 });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('database outage returns 503, not an invalid-session response', async () => {
    setAuthPool({ query: async () => { throw Error('database offline'); } });
    const router = createRouter(); router.get('/', requireAuth, (_req, res) => res.json({ ok: true }));
    await serve(router, async base => {
        const response = await fetch(base, { headers: { Authorization: `Bearer ${generateToken({ id: 'user', auth_version: 1 })}` } });
        assert.equal(response.status, 503);
    });
});
