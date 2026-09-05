'use strict';
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
assert.match(process.env.COMPOSE_PROJECT_NAME || '', /^soundraft-gate-/);
assert.equal(process.env.DB_NAME, 'gate_catalog');
const base = process.env.E2E_BASE_URL;
const compose = (...args) => execFileSync('docker', ['compose', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
const sql = text => compose('exec', '-T', 'db', 'psql', '-U', process.env.DB_USER, '-d', process.env.DB_NAME, '-Atc', text).toString().trim();
async function until(check, label) {
    for (let i = 0; i < 60; i++) {
        if (await check().catch(() => false)) return;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw Error(label);
}
async function run() {
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    async function api(route, method = 'GET', body) {
        return fetch(base + route, { method, signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${token}`,
            ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
    }
    const { track } = await (await api('/api/tracks', 'POST', { title: 'Restart fault fixture' })).json();
    assert.match(track.id, /^[a-f0-9-]{36}$/);
    const form = () => {
        const data = new FormData(); data.append('audio', new Blob([fs.readFileSync(path.join(__dirname, '../seed-data/example-track.wav'))], { type: 'audio/wav' }), 'fault.wav'); return data;
    };
    const storageId = compose('ps', '-q', 'storage').toString().trim();
    execFileSync('docker', ['pause', storageId]);
    try {
        const uploading = api(`/api/tracks/${track.id}/versions`, 'POST', form()).catch(() => null);
        await until(async () => Number(sql(`SELECT COUNT(*) FROM storage_objects WHERE storage_key LIKE 'tracks/${track.id}/versions/%' AND state='STAGED'`)) > 0, 'Upload did not stage');
        compose('kill', '-s', 'SIGKILL', 'api');
        await uploading;
        assert.equal(Number(sql(`SELECT COUNT(*) FROM track_versions WHERE track_id='${track.id}'`)), 0);
        sql(`UPDATE storage_objects SET created_at=NOW()-INTERVAL '2 hours' WHERE storage_key LIKE 'tracks/${track.id}/versions/%' AND state='STAGED'`);
    } finally { execFileSync('docker', ['unpause', storageId]); }
    compose('up', '-d', '--wait', 'api');
    await until(async () => Number(sql("SELECT COUNT(*) FROM storage_objects WHERE state='STAGED'")) === 0, 'Restart did not reclaim staging');
    assert.equal((await api(`/api/tracks/${track.id}/versions`, 'POST', form())).status, 201);
    execFileSync('docker', ['pause', storageId]);
    try {
        assert.equal((await api(`/api/tracks/${track.id}`, 'DELETE')).status, 200);
        compose('kill', '-s', 'SIGKILL', 'api');
    } finally { execFileSync('docker', ['unpause', storageId]); }
    compose('up', '-d', '--wait', 'api');
    await until(async () => Number(sql("SELECT COUNT(*) FROM object_deletion_outbox WHERE processed_at IS NULL")) === 0, 'Deletion backlog did not recover');
    compose('stop', 'db');
    try {
        assert.equal((await fetch(base + '/api/live')).status, 200);
        assert.equal((await api('/api/tracks')).status, 503);
        assert.equal((await fetch(base + '/api/ready')).status, 503);
    } finally { compose('up', '-d', '--wait', 'db'); }
    await until(async () => (await fetch(base + '/api/ready')).status === 200, 'Database readiness did not recover');
    console.log('PASS: process restart during staged upload/deletion and database disconnect recovery');
}
run().catch(() => { console.error('Real-service fault gate failed'); process.exitCode = 1; });
