'use strict';
// Isolated local browser harness; CI's real-service gate serves the same build
// from its production container against PostgreSQL 15 and real MinIO.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');
const express = require('express');
(async () => {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soundraft-browser-'));
    const net = require('node:net');
    const socket = net.createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const db = new EmbeddedPostgres({ databaseDir: path.join(directory, 'data'), user: 'postgres', password: 'browser-only-password',
        port, persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog() {}, onError() {} });
    await db.initialise(); await db.start(); await db.createDatabase('soundraft_browser');
    Object.assign(process.env, { DATABASE_URL: `postgresql://postgres:browser-only-password@127.0.0.1:${port}/soundraft_browser`,
        JWT_SECRET: 'browser-only-jwt-secret-with-more-than-thirty-two-characters', S3_ACCESS_KEY: 'browser-only-key',
        S3_SECRET_KEY: 'browser-only-secret', S3_ENDPOINT: 'http://127.0.0.1:9999', RESOURCE_GRANT_TTL: '5s',
        ADMIN_EMAIL: 'browser@example.com', ADMIN_PASSWORD: 'browser-only-password' });
    const { app, pool, minioClient, runMigrations, initialize } = require('../index');
    const objects = new Map();
    minioClient.bucketExists = async () => true;
    minioClient.fPutObject = async (_bucket, key, file) => objects.set(key, await fs.readFile(file));
    minioClient.statObject = async (_bucket, key) => {
        if (!objects.has(key)) throw Object.assign(Error('missing fixture'), { code: 'NoSuchKey' });
        return { size: objects.get(key).length, metaData: {} };
    };
    minioClient.getObject = async (_bucket, key) => Readable.from([objects.get(key)]);
    minioClient.getPartialObject = async (_bucket, key, start, length) => Readable.from([objects.get(key).subarray(start, start + length)]);
    minioClient.removeObject = async (_bucket, key) => objects.delete(key);
    await pool.query(await fs.readFile(path.join(__dirname, '../db/init.sql'), 'utf8'));
    await runMigrations(); await initialize();
    const built = path.resolve(__dirname, '../../client/dist');
    app.use(express.static(built)); app.get('*', (_req, res) => res.sendFile(path.join(built, 'index.html')));
    const server = app.listen(4173, '127.0.0.1');
    let stopping = false;
    const stop = async () => {
        if (stopping) return; stopping = true;
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await pool.end(); await db.stop();
        if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('soundraft-browser-')) await fs.rm(directory, { recursive: true, force: true });
        process.exit(0);
    };
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch(() => { console.error('Isolated browser server startup failed'); process.exit(1); });
