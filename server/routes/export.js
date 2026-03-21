const express = require('express');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');
const { requireAuthWithQuery } = require('../middleware/auth');

const router = express.Router();

const exportLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many export requests. Please wait a moment.' },
});

// Sanitize folder/file names for zip paths
function sanitize(name) {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, ' ').trim() || 'Untitled';
}

// Deduplicate folder names
function dedup(name, usedSet) {
    let candidate = name;
    let i = 2;
    while (usedSet.has(candidate)) {
        candidate = `${name} (${i++})`;
    }
    usedSet.add(candidate);
    return candidate;
}

// Extract MinIO storage key from cover_art_path (strips /api/storage/ prefix)
function coverKeyFromPath(coverArtPath) {
    if (!coverArtPath) return null;
    return coverArtPath.replace(/^\/api\/storage\//, '');
}

// Format timestamp as M:SS
function formatTimestamp(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

// Format comments into readable text
function formatComments(comments) {
    if (!comments || comments.length === 0) return 'No comments.\n';

    return comments.map(c => {
        const date = new Date(c.created_at).toLocaleString();
        const author = c.user_email || 'Anonymous';
        const timestamp = c.audio_timestamp != null
            ? ` [at ${formatTimestamp(c.audio_timestamp)}]`
            : '';
        return `[${date}] ${author}${timestamp}:\n${c.body}`;
    }).join('\n\n---\n\n') + '\n';
}

module.exports = function(pool, minioClient, BUCKET_NAME, upload) {

    // Stream a MinIO object into the archive, skip if missing
    async function appendMinioObject(archive, storageKey, zipPath) {
        try {
            const stream = await minioClient.getObject(BUCKET_NAME, storageKey);
            archive.append(stream, { name: zipPath });
        } catch (err) {
            console.warn(`Export: skipping missing object ${storageKey}: ${err.message}`);
        }
    }

    /**
     * GET /api/export/library?mode=tracks|playlists&auth=TOKEN
     * Streams the user's entire library as a .zip file
     */
    router.get('/library', exportLimiter, requireAuthWithQuery, async (req, res) => {
        const userId = req.user.id;
        const mode = req.query.mode || 'tracks';

        if (!['tracks', 'playlists'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode. Use "tracks" or "playlists".' });
        }

        try {
            // --- Query all owned data ---

            // All owned tracks with their versions
            const tracksResult = await pool.query(`
                SELECT t.id as track_id, t.title as track_title, t.artist as track_artist,
                       t.cover_art_path,
                       tv.id as version_id, tv.version_number, tv.filename as version_filename,
                       tv.storage_key as version_storage_key, tv.mime_type
                FROM tracks t
                LEFT JOIN track_versions tv ON tv.track_id = t.id
                WHERE t.owner_id = $1
                ORDER BY t.title ASC, tv.version_number ASC
            `, [userId]);

            // All attachments for owned tracks
            const attachmentsResult = await pool.query(`
                SELECT a.id, a.track_id, a.filename, a.storage_key
                FROM attachments a
                JOIN tracks t ON a.track_id = t.id
                WHERE t.owner_id = $1
                ORDER BY a.track_id, a.sort_order ASC
            `, [userId]);

            // All comments on owned tracks
            const trackCommentsResult = await pool.query(`
                SELECT c.track_id, c.body, c.audio_timestamp, c.created_at,
                       u.email as user_email
                FROM comments c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.track_id IN (SELECT id FROM tracks WHERE owner_id = $1)
                ORDER BY c.track_id, c.audio_timestamp ASC NULLS LAST, c.created_at ASC
            `, [userId]);

            // All comments on owned playlists
            const playlistCommentsResult = await pool.query(`
                SELECT c.playlist_id, c.body, c.created_at,
                       u.email as user_email
                FROM comments c
                LEFT JOIN users u ON c.user_id = u.id
                WHERE c.playlist_id IN (SELECT id FROM playlists WHERE owner_id = $1)
                ORDER BY c.playlist_id, c.created_at ASC
            `, [userId]);

            // All owned playlists with track associations
            const playlistsResult = await pool.query(`
                SELECT p.id as playlist_id, p.title as playlist_title, p.artist as playlist_artist,
                       p.type as playlist_type, p.cover_art_path as playlist_cover_art_path,
                       pt.sort_order,
                       t.id as track_id
                FROM playlists p
                LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
                LEFT JOIN tracks t ON pt.track_id = t.id
                WHERE p.owner_id = $1
                ORDER BY p.title ASC, pt.sort_order ASC
            `, [userId]);

            // --- Build lookup maps ---

            const trackMap = new Map(); // trackId -> { title, artist, coverArtPath, versions, attachments, comments }

            for (const row of tracksResult.rows) {
                if (!trackMap.has(row.track_id)) {
                    trackMap.set(row.track_id, {
                        title: row.track_title,
                        artist: row.track_artist,
                        coverArtPath: row.cover_art_path,
                        versions: [],
                        attachments: [],
                        comments: [],
                    });
                }
                if (row.version_id) {
                    trackMap.get(row.track_id).versions.push({
                        versionNumber: row.version_number,
                        filename: row.version_filename,
                        storageKey: row.version_storage_key,
                    });
                }
            }

            // Populate attachments
            for (const row of attachmentsResult.rows) {
                const track = trackMap.get(row.track_id);
                if (track) {
                    track.attachments.push({
                        filename: row.filename,
                        storageKey: row.storage_key,
                    });
                }
            }

            // Populate track comments
            for (const row of trackCommentsResult.rows) {
                const track = trackMap.get(row.track_id);
                if (track) {
                    track.comments.push(row);
                }
            }

            // Build playlist map
            const playlistMap = new Map(); // playlistId -> { title, artist, type, coverArtPath, trackIds, comments }

            for (const row of playlistsResult.rows) {
                if (!playlistMap.has(row.playlist_id)) {
                    playlistMap.set(row.playlist_id, {
                        title: row.playlist_title,
                        artist: row.playlist_artist,
                        type: row.playlist_type,
                        coverArtPath: row.playlist_cover_art_path,
                        trackIds: [],
                        comments: [],
                    });
                }
                if (row.track_id) {
                    playlistMap.get(row.playlist_id).trackIds.push(row.track_id);
                }
            }

            // Populate playlist comments
            for (const row of playlistCommentsResult.rows) {
                const playlist = playlistMap.get(row.playlist_id);
                if (playlist) {
                    playlist.comments.push(row);
                }
            }

            // --- Set response headers and create archive ---

            const timestamp = new Date().toISOString().slice(0, 10);
            const filename = `SoundRaft-Library-${timestamp}.zip`;

            res.setHeader('Content-Type', 'application/zip');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.setHeader('Transfer-Encoding', 'chunked');

            // Disable response timeout for large exports
            res.setTimeout(0);

            const archive = archiver('zip', { zlib: { level: 5 } });

            archive.on('error', (err) => {
                console.error('Archive error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Archive creation failed' });
                }
            });

            archive.on('warning', (err) => {
                console.warn('Archive warning:', err.message);
            });

            // Abort archive if client disconnects
            let aborted = false;
            req.on('close', () => {
                if (!res.writableEnded) {
                    aborted = true;
                    archive.abort();
                }
            });

            archive.pipe(res);

            const ROOT = 'SoundRaft-Library';

            // --- Assemble zip based on mode ---

            if (mode === 'tracks') {
                const usedNames = new Set();

                for (const [trackId, track] of trackMap) {
                    if (aborted) break;

                    const folderName = dedup(sanitize(track.title), usedNames);
                    const trackFolder = `${ROOT}/${folderName}/`;

                    // Audio versions
                    for (const version of track.versions) {
                        const versionFile = `v${version.versionNumber} - ${sanitize(version.filename)}`;
                        await appendMinioObject(archive, version.storageKey, `${trackFolder}audio/${versionFile}`);
                    }

                    // Cover art
                    const coverKey = coverKeyFromPath(track.coverArtPath);
                    if (coverKey) {
                        const ext = coverKey.split('.').pop() || 'jpg';
                        await appendMinioObject(archive, coverKey, `${trackFolder}cover-art/cover.${ext}`);
                    }

                    // Attachments
                    for (const attachment of track.attachments) {
                        await appendMinioObject(archive, attachment.storageKey,
                            `${trackFolder}attachments/${sanitize(attachment.filename)}`);
                    }

                    // Comments
                    const commentsText = formatComments(track.comments);
                    archive.append(commentsText, { name: `${trackFolder}comments.txt` });
                }
            } else {
                // Playlists mode
                const usedPlaylistNames = new Set();

                for (const [playlistId, playlist] of playlistMap) {
                    if (aborted) break;

                    const playlistFolderName = dedup(sanitize(playlist.title), usedPlaylistNames);
                    const playlistFolder = `${ROOT}/${playlistFolderName}/`;

                    // Playlist cover art
                    const playlistCoverKey = coverKeyFromPath(playlist.coverArtPath);
                    if (playlistCoverKey) {
                        const ext = playlistCoverKey.split('.').pop() || 'jpg';
                        await appendMinioObject(archive, playlistCoverKey, `${playlistFolder}cover-art/cover.${ext}`);
                    }

                    // Tracks within playlist
                    const usedTrackNames = new Set();
                    for (let i = 0; i < playlist.trackIds.length; i++) {
                        if (aborted) break;

                        const trackId = playlist.trackIds[i];
                        const track = trackMap.get(trackId);
                        if (!track) continue;

                        const orderPrefix = String(i + 1).padStart(2, '0');
                        const trackFolderName = dedup(`${orderPrefix} - ${sanitize(track.title)}`, usedTrackNames);
                        const trackFolder = `${playlistFolder}${trackFolderName}/`;

                        // Audio versions
                        for (const version of track.versions) {
                            const versionFile = `v${version.versionNumber} - ${sanitize(version.filename)}`;
                            await appendMinioObject(archive, version.storageKey, `${trackFolder}audio/${versionFile}`);
                        }

                        // Track cover art
                        const coverKey = coverKeyFromPath(track.coverArtPath);
                        if (coverKey) {
                            const ext = coverKey.split('.').pop() || 'jpg';
                            await appendMinioObject(archive, coverKey, `${trackFolder}cover-art/cover.${ext}`);
                        }

                        // Attachments
                        for (const attachment of track.attachments) {
                            await appendMinioObject(archive, attachment.storageKey,
                                `${trackFolder}attachments/${sanitize(attachment.filename)}`);
                        }

                        // Track comments
                        const commentsText = formatComments(track.comments);
                        archive.append(commentsText, { name: `${trackFolder}comments.txt` });
                    }

                    // Playlist-level comments
                    const playlistCommentsText = formatComments(playlist.comments);
                    archive.append(playlistCommentsText, { name: `${playlistFolder}comments.txt` });
                }
            }

            await archive.finalize();

        } catch (err) {
            console.error('Export library error:', err);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to export library' });
            }
        }
    });

    return router;
};
