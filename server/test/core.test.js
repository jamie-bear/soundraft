'use strict';

process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-thirty-two-characters';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const multer = require('multer');

const { generateToken, requireAuth } = require('../middleware/auth');
const { evaluateResourceAccess } = require('../lib/access');
const { addResourceUrls, issueGrant, verifyGrant } = require('../lib/grants');
const { validateConfig, validateResourceGrantTtl } = require('../lib/config');

const USER = { id: '11111111-1111-4111-8111-111111111111', email: 'user@example.com', role: 'USER' };
const OWNER = { id: '22222222-2222-4222-8222-222222222222', email: 'owner@example.com', role: 'USER' };
const LEGACY_UUID_SHARE_TOKEN = '33333333-3333-4333-8333-333333333333';

function normalized(sql) {
    return sql.replace(/\s+/g, ' ').trim();
}

function authHeader(user = USER) {
    return { Authorization: `Bearer ${generateToken(user)}` };
}

async function withServer(router, callback) {
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = await new Promise(resolve => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();

    try {
        return await callback(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
}

test('resource access requires both public visibility and the matching share token', () => {
    const track = {
        id: 'track-id',
        owner_id: OWNER.id,
        share_token: 'share-token',
        release_status: 'PUBLIC',
    };

    assert.equal(evaluateResourceAccess({
        resource: track,
        resourceType: 'track',
        identifier: track.id,
        queryToken: null,
        user: null,
    }).allowed, false);

    assert.equal(evaluateResourceAccess({
        resource: track,
        resourceType: 'track',
        identifier: track.id,
        queryToken: 'share-token',
        user: null,
    }).allowed, true);

    track.release_status = 'PRIVATE';
    assert.equal(evaluateResourceAccess({
        resource: track,
        resourceType: 'track',
        identifier: track.id,
        queryToken: 'share-token',
        user: USER,
    }).allowed, false);
});

test('resource URLs contain scoped grants that cannot be reused for another version or object', () => {
    const resource = addResourceUrls({
        current_version_id: 'version-one',
        cover_art_path: '/api/storage/covers/cover.jpg',
    });
    const streamGrant = new URL(resource.stream_url, 'http://localhost').searchParams.get('grant');
    const storageGrant = new URL(resource.cover_art_path, 'http://localhost').searchParams.get('grant');

    assert.equal(verifyGrant(streamGrant, { purpose: 'stream', version_id: 'version-one' }), true);
    assert.equal(verifyGrant(streamGrant, { purpose: 'stream', version_id: 'version-two' }), false);
    assert.equal(verifyGrant(storageGrant, { purpose: 'storage', storage_key: 'covers/cover.jpg' }), true);
    assert.equal(verifyGrant(storageGrant, { purpose: 'stream', version_id: 'version-one' }), false);
});

test('resource grants cannot be reused as API session tokens', async () => {
    const router = express.Router();
    router.get('/protected', requireAuth, (_req, res) => res.json({ ok: true }));

    await withServer(router, async baseUrl => {
        const grant = issueGrant({ purpose: 'stream', version_id: 'version-one' });
        const grantResponse = await fetch(`${baseUrl}/protected`, {
            headers: { Authorization: `Bearer ${grant}` },
        });
        assert.equal(grantResponse.status, 401);

        const sessionResponse = await fetch(`${baseUrl}/protected`, {
            headers: authHeader(),
        });
        assert.equal(sessionResponse.status, 200);
    });
});

test('configuration rejects the historical development defaults', () => {
    assert.throws(() => validateConfig({
        DATABASE_URL: 'postgresql://soundraft:password@db/soundraft',
        JWT_SECRET: 'dev_secret_change_me',
        S3_ACCESS_KEY: 'minioadmin',
        S3_SECRET_KEY: 'minioadmin',
        ADMIN_EMAIL: 'admin@example.com',
        ADMIN_PASSWORD: 'admin',
    }), /JWT_SECRET/);
    assert.throws(() => validateResourceGrantTtl('7d'), /seconds, minutes, or hours/);
    assert.throws(() => validateResourceGrantTtl('25h'), /24 hours/);
});

test('track creation uses the standalone sanitizer and returns playable resource fields', async () => {
    const pool = {
        async query(sql, params) {
            const query = normalized(sql);
            if (query.startsWith('INSERT INTO tracks')) {
                assert.equal(params[1], 'Safe title');
                return { rows: [{
                    id: 'track-id',
                    owner_id: USER.id,
                    title: params[1],
                    artist: null,
                    status: 'WIP',
                    type: 'RELEASE',
                    release_status: 'PRIVATE',
                    comment_access: 'PRIVATE',
                    share_token: params[5],
                    current_version_id: null,
                    cover_art_path: null,
                }] };
            }
            if (query.includes('WHERE t.id = $1')) return { rows: [] };
            if (query.includes('WHERE t.share_token = $1')) {
                return { rows: [{
                    id: '44444444-4444-4444-8444-444444444444',
                    owner_id: OWNER.id,
                    title: 'Legacy shared track',
                    release_status: 'PUBLIC',
                    share_token: LEGACY_UUID_SHARE_TOKEN,
                    current_version_id: null,
                    cover_art_path: null,
                }] };
            }
            throw new Error(`Unexpected query: ${query}`);
        },
    };
    const upload = { single: () => (_req, _res, next) => next() };
    const router = require('../routes/tracks')(pool, {}, 'tracks', upload);

    await withServer(router, async baseUrl => {
        const response = await fetch(`${baseUrl}/`, {
            method: 'POST',
            headers: { ...authHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: '<b>Safe title</b>' }),
        });
        const body = await response.json();
        assert.equal(response.status, 201);
        assert.equal(body.track.title, 'Safe title');
        assert.equal(body.track.stream_url, null);

        const sharedResponse = await fetch(
            `${baseUrl}/${LEGACY_UUID_SHARE_TOKEN}?token=${LEGACY_UUID_SHARE_TOKEN}`
        );
        assert.equal(sharedResponse.status, 200);
    });
});

test('playlist creation uses the standalone sanitizer', async () => {
    const pool = {
        async query(sql, params) {
            assert.match(normalized(sql), /^INSERT INTO playlists/);
            assert.equal(params[1], 'Release queue');
            return { rows: [{
                id: 'playlist-id', owner_id: USER.id, title: params[1], artist: null,
                type: 'PLAYLIST', is_public: false, comment_access: 'PRIVATE',
                share_token: params[4], cover_art_path: null,
            }] };
        },
    };
    const upload = { single: () => (_req, _res, next) => next() };
    const router = require('../routes/playlists')(pool, {}, 'tracks', upload);

    await withServer(router, async baseUrl => {
        const response = await fetch(`${baseUrl}/`, {
            method: 'POST',
            headers: { ...authHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: '<i>Release queue</i>' }),
        });
        const body = await response.json();
        assert.equal(response.status, 201);
        assert.equal(body.playlist.title, 'Release queue');
    });
});

test('a signed-in visitor can post to PUBLIC_FULL with a valid share token', async () => {
    const pool = {
        async query(sql, params) {
            const query = normalized(sql);
            if (query.startsWith('SELECT id, owner_id, share_token')) {
                return { rows: [{
                    id: 'track-id', owner_id: OWNER.id, share_token: 'share-token',
                    comment_access: 'PUBLIC_FULL', release_status: 'PUBLIC',
                }] };
            }
            if (query.startsWith('INSERT INTO comments')) {
                assert.equal(params[0], USER.id);
                assert.equal(params[2], 'A useful note');
                assert.equal(params[3], 0);
                return { rows: [{ id: 'comment-id', body: params[2], audio_timestamp: params[3] }] };
            }
            throw new Error(`Unexpected query: ${query}`);
        },
    };
    const router = require('../routes/comments')(pool);

    await withServer(router, async baseUrl => {
        const response = await fetch(`${baseUrl}/track/track-id`, {
            method: 'POST',
            headers: { ...authHeader(), 'Content-Type': 'application/json' },
            body: JSON.stringify({ body: '<b>A useful note</b>', audioTimestamp: 0, token: 'share-token' }),
        });
        const body = await response.json();
        assert.equal(response.status, 201);
        assert.equal(body.comment.audio_timestamp, 0);
    });
});

test('attachment upload streams the disk file to object storage and always removes the temp file', async () => {
    const uploadDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soundraft-test-'));
    let uploadedPath;
    let uploadedContent;
    const upload = multer({ storage: multer.diskStorage({ destination: uploadDir }) });
    const pool = {
        async query(sql, params) {
            const query = normalized(sql);
            if (query.startsWith('SELECT owner_id FROM tracks')) {
                return { rows: [{ owner_id: USER.id }] };
            }
            if (query.startsWith('INSERT INTO attachments')) {
                return { rows: [{ id: 'attachment-id', filename: params[1], size_bytes: params[3] }] };
            }
            throw new Error(`Unexpected query: ${query}`);
        },
    };
    const minio = {
        async fPutObject(_bucket, _key, filePath) {
            uploadedPath = filePath;
            uploadedContent = await fs.promises.readFile(filePath, 'utf8');
        },
    };
    const router = require('../routes/attachments')(pool, minio, 'tracks', upload);

    try {
        await withServer(router, async baseUrl => {
            const form = new FormData();
            form.append('file', new Blob(['attachment body'], { type: 'text/plain' }), 'notes.txt');
            const response = await fetch(`${baseUrl}/track/track-id`, {
                method: 'POST',
                headers: authHeader(),
                body: form,
            });
            assert.equal(response.status, 201);
            assert.equal(uploadedContent, 'attachment body');
            assert.equal(fs.existsSync(uploadedPath), false);
        });
    } finally {
        await fs.promises.rm(uploadDir, { recursive: true, force: true });
    }
});
