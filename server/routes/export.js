const { logError } = require('../lib/logging');
'use strict';

const express = require('express');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const { Readable } = require('stream');
const { finished } = require('stream/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const snapshots = new AsyncLocalStorage();
const { requireAuth } = require('../middleware/auth');
const { issueGrant, readGrant } = require('../lib/grants');

const exportLimiter = rateLimit({ windowMs: 60_000, max: 4, standardHeaders: true, legacyHeaders: false });
const PAGE_SIZE = 25;
const CHILD_PAGE_SIZE = 100;
const QUERY_TIMEOUT_MS = Number(process.env.EXPORT_QUERY_TIMEOUT_MS || 30_000);
const MAX_EXPORT_ENTRIES = Number(process.env.MAX_EXPORT_ENTRIES || 20000);
const EXPORT_TIMEOUT_MS = Number(process.env.EXPORT_TIMEOUT_MS || 15 * 60_000);

function sanitize(name) {
    return String(name || 'Untitled').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim() || 'Untitled';
}

function coverKey(path) {
    return path ? path.replace(/^\/api\/storage\//, '') : null;
}

function commentText(comment) {
    const seconds = comment.audio_timestamp;
    const marker = seconds == null ? '' : ` [at ${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}]`;
    return `[${new Date(comment.created_at).toISOString()}] ${comment.user_email || 'Anonymous'}${marker}:\n${comment.body}\n\n---\n\n`;
}

module.exports = function(pool, minioClient, bucket) {
    const router = require('../lib/router').createRouter();
        const query = (text, values) => (snapshots.getStore() || pool).query({ text, values, query_timeout: QUERY_TIMEOUT_MS });

    function appendEntry(archive, source, options, state) {
        if (++state.entries > MAX_EXPORT_ENTRIES) throw new Error('Export entry limit exceeded');
        archive.append(source, options);
    }

    async function appendObject(archive, storageKey, name, state) {
        if (!storageKey || state.aborted) return;
        let stream;
        try {
            stream = await minioClient.getObject(bucket, storageKey);
            if (state.aborted) { stream.destroy(); return; }
            state.activeStream = stream;
            appendEntry(archive, stream, { name }, state);
            await finished(stream);
        } catch (error) {
            if (!state.aborted) throw error;
        } finally {
            if (state.activeStream === stream) state.activeStream = null;
        }
    }

    async function* commentChunks(column, resourceId, state) {
        let cursorDate = null;
        let cursorId = null;
        let found = false;
        while (!state.aborted) {
            const result = await query(`
                SELECT c.id, c.body, c.audio_timestamp, c.created_at, u.email AS user_email
                FROM comments c LEFT JOIN users u ON u.id = c.user_id
                WHERE c.${column} = $1
                  AND ($2::timestamptz IS NULL OR (c.created_at, c.id) > ($2::timestamptz, $3::uuid))
                ORDER BY c.created_at, c.id LIMIT $4
            `, [resourceId, cursorDate, cursorId, CHILD_PAGE_SIZE]);
            if (!result.rows.length) break;
            found = true;
            for (const row of result.rows) yield commentText(row);
            const last = result.rows[result.rows.length - 1];
            cursorDate = last.created_at;
            cursorId = last.id;
            if (result.rows.length < CHILD_PAGE_SIZE) break;
        }
        if (!found) yield 'No comments.\n';
    }

    async function appendComments(archive, column, id, name, state) {
        const stream = Readable.from(commentChunks(column, id, state));
        state.activeStream = stream;
        appendEntry(archive, stream, { name }, state);
        try { await finished(stream); } finally { if (state.activeStream === stream) state.activeStream = null; }
    }

    async function appendTrack(archive, track, folder, state) {
        let versionNumber = null;
        let versionId = null;
        while (!state.aborted) {
            const versions = await query(`
                SELECT id, version_number, filename, storage_key FROM track_versions
                WHERE track_id = $1 AND ($2::int IS NULL OR (version_number, id) > ($2::int, $3::uuid))
                ORDER BY version_number, id LIMIT $4
            `, [track.id, versionNumber, versionId, CHILD_PAGE_SIZE]);
            for (const version of versions.rows) {
                await appendObject(archive, version.storage_key,
                    `${folder}audio/v${version.version_number} - ${sanitize(version.filename)}`, state);
            }
            if (versions.rows.length < CHILD_PAGE_SIZE) break;
            const last = versions.rows[versions.rows.length - 1];
            versionNumber = last.version_number;
            versionId = last.id;
        }

        const key = coverKey(track.cover_art_path);
        if (key) await appendObject(archive, key, `${folder}cover-art/cover.${key.split('.').pop() || 'jpg'}`, state);

        let attachmentOrder = null;
        let attachmentId = null;
        while (!state.aborted) {
            const attachments = await query(`
                SELECT id, filename, storage_key, sort_order FROM attachments
                WHERE track_id = $1 AND ($2::int IS NULL OR (sort_order, id) > ($2::int, $3::uuid))
                ORDER BY sort_order, id LIMIT $4
            `, [track.id, attachmentOrder, attachmentId, CHILD_PAGE_SIZE]);
            for (const attachment of attachments.rows) {
                await appendObject(archive, attachment.storage_key,
                    `${folder}attachments/${attachment.id} - ${sanitize(attachment.filename)}`, state);
            }
            if (attachments.rows.length < CHILD_PAGE_SIZE) break;
            const last = attachments.rows[attachments.rows.length - 1];
            attachmentOrder = last.sort_order;
            attachmentId = last.id;
        }
        await appendComments(archive, 'track_id', track.id, `${folder}comments.txt`, state);
    }

    router.post('/grant', exportLimiter, requireAuth, (req, res) => {
        const mode = req.body.mode || 'tracks';
        if (!['tracks', 'playlists'].includes(mode)) return res.status(400).json({ error: 'Invalid export mode' });
        const grant = issueGrant({ purpose: 'library-export', mode, user_id: req.user.id,
            auth_version: Number(req.user.auth_version) }, '5m');
        res.json({ url: `/api/export/library?grant=${encodeURIComponent(grant)}` });
    });

    router.get('/library', exportLimiter, async (req, res) => {
        const grant = readGrant(req.query.grant, { purpose: 'library-export' });
        if (!grant || !['tracks', 'playlists'].includes(grant.mode)) {
            return res.status(401).json({ error: 'Invalid or expired export grant' });
        }
        let user;
        try {
            user = await query('SELECT is_active, auth_version FROM users WHERE id = $1', [grant.user_id]);
        } catch (error) {
            logError('Export authorization error:', error);
            return res.status(500).json({ error: 'Failed to authorize export' });
        }
        if (!user.rows[0]?.is_active || Number(user.rows[0].auth_version) !== Number(grant.auth_version)) {
            return res.status(403).json({ error: 'Export access revoked' });
        }

        let client;
        try { client = await pool.connect(); }
        catch { return res.status(503).json({ error: 'Export capacity unavailable; please retry' }); }
        try {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            // The reconciler takes the exclusive counterpart before touching media.
            await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('soundraft:exports'))");
            await snapshots.run(client, async () => {
                const archive = new archiver.ZipArchive({ zlib: { level: 5 } });
                const state = { aborted: false, activeStream: null, entries: 0 };
                const abort = () => {
                    if (state.aborted) return;
                    state.aborted = true;
                    state.activeStream?.destroy();
                    archive.abort();
                    if (!res.writableEnded) res.destroy();
                };
                const deadline = setTimeout(abort, EXPORT_TIMEOUT_MS);
                deadline.unref?.();
                req.once('aborted', abort);
                res.once('close', () => { if (!res.writableEnded) abort(); });
                archive.once('error', (error) => {
                    logError('Archive error:', error);
                    abort();
                });

                try {
                    const date = new Date().toISOString().slice(0, 10);
                    res.setHeader('Content-Type', 'application/zip');
                    res.setHeader('Content-Disposition', `attachment; filename="SoundRaft-Library-${date}.zip"`);
                    res.setTimeout(EXPORT_TIMEOUT_MS, abort);
                    archive.pipe(res);
                    const root = 'SoundRaft-Library/';

                    if (grant.mode === 'tracks') {
                        let cursorTitle = null;
                        let cursorId = null;
                        while (!state.aborted) {
                            const tracks = await query(`
                                SELECT id, title, cover_art_path FROM tracks WHERE owner_id = $1
                                  AND ($2::text IS NULL OR (title, id) > ($2::text, $3::uuid))
                                ORDER BY title, id LIMIT $4
                            `, [grant.user_id, cursorTitle, cursorId, PAGE_SIZE]);
                            for (const track of tracks.rows) {
                                await appendTrack(archive, track, `${root}${sanitize(track.title)}-${track.id.slice(0, 8)}/`, state);
                            }
                            if (tracks.rows.length < PAGE_SIZE) break;
                            const last = tracks.rows[tracks.rows.length - 1];
                            cursorTitle = last.title;
                            cursorId = last.id;
                        }
                    } else {
                        let playlistTitle = null;
                        let playlistId = null;
                        while (!state.aborted) {
                            const playlists = await query(`
                                SELECT id, title, cover_art_path FROM playlists WHERE owner_id = $1
                                  AND ($2::text IS NULL OR (title, id) > ($2::text, $3::uuid))
                                ORDER BY title, id LIMIT $4
                            `, [grant.user_id, playlistTitle, playlistId, PAGE_SIZE]);
                            for (const playlist of playlists.rows) {
                                const folder = `${root}${sanitize(playlist.title)}-${playlist.id.slice(0, 8)}/`;
                                const key = coverKey(playlist.cover_art_path);
                                if (key) await appendObject(archive, key, `${folder}cover-art/cover.${key.split('.').pop() || 'jpg'}`, state);
                                let sortOrder = null;
                                let trackId = null;
                                while (!state.aborted) {
                                    const tracks = await query(`
                                        SELECT t.id, t.title, t.cover_art_path, pt.sort_order
                                        FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                                        WHERE pt.playlist_id = $1
                                          AND ($2::int IS NULL OR (pt.sort_order, t.id) > ($2::int, $3::uuid))
                                        ORDER BY pt.sort_order, t.id LIMIT $4
                                    `, [playlist.id, sortOrder, trackId, PAGE_SIZE]);
                                    for (const track of tracks.rows) {
                                        const prefix = String(track.sort_order + 1).padStart(3, '0');
                                        await appendTrack(archive, track,
                                            `${folder}${prefix} - ${sanitize(track.title)}-${track.id.slice(0, 8)}/`, state);
                                    }
                                    if (tracks.rows.length < PAGE_SIZE) break;
                                    const last = tracks.rows[tracks.rows.length - 1];
                                    sortOrder = last.sort_order;
                                    trackId = last.id;
                                }
                                await appendComments(archive, 'playlist_id', playlist.id, `${folder}comments.txt`, state);
                            }
                            if (playlists.rows.length < PAGE_SIZE) break;
                            const last = playlists.rows[playlists.rows.length - 1];
                            playlistTitle = last.title;
                            playlistId = last.id;
                        }
                    }
                    if (!state.aborted) await archive.finalize();
                } catch (error) {
                    logError('Export library error:', error);
                    abort();
                } finally {
                    clearTimeout(deadline);
                }
            });
            await client.query('ROLLBACK');
        } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            if (!res.headersSent && !res.destroyed) res.status(503).json({ error: 'Export unavailable; please retry' });
            else res.destroy();
        } finally { client.release(); }
    });

    return router;
};
