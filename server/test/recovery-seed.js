'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');

async function seed() {
    const base = 'http://127.0.0.1:8080/api';
    const login = await fetch(base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
    assert.equal(login.status, 200);
    const { token } = await login.json();
    async function api(path, method = 'GET', body) {
        const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`,
            ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) },
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
        assert.ok(response.ok, `${method} ${path}: ${response.status}`);
        return response.json();
    }
    const { track } = await api('/tracks', 'POST', { title: 'Recovery fixture' });
    for (const [field, endpoint, file, mime] of [
        ['audio', `/tracks/${track.id}/versions`, 'seed-data/example-track.wav', 'audio/wav'],
        ['cover', `/tracks/${track.id}/cover`, 'seed-data/example-track-cover.jpg', 'image/jpeg'],
        ['file', `/attachments/track/${track.id}`, 'seed-data/example-track.wav', 'audio/wav'],
    ]) {
        const form = new FormData(); form.append(field, new Blob([fs.readFileSync(file)], { type: mime }), file.split('/').pop());
        await api(endpoint, 'POST', form);
    }
    const { playlist } = await api('/playlists', 'POST', { title: 'Recovery playlist' });
    await api(`/playlists/${playlist.id}/tracks`, 'POST', { trackId: track.id });
    await api(`/playlists/${playlist.id}/share`, 'POST', { makePublic: true });
    console.log('Seeded audio, cover, attachment and shared playlist through real HTTP and MinIO.');
}
seed().catch(() => { console.error('Recovery seed failed'); process.exitCode = 1; });
