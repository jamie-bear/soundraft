const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const Minio = require('minio');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

// Trust the first proxy hop (Caddy, nginx, etc.) so req.protocol reflects
// X-Forwarded-Proto and OG meta URLs use https:// on proxied deployments.
app.set('trust proxy', 1);

// Security headers via helmet with CSP enabled for SPA
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "blob:", "data:"],
            mediaSrc: ["'self'", "blob:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
        },
    },
    crossOriginEmbedderPolicy: false, // Allow audio/image loading
}));

// Restrict CORS to configured origins
const corsOrigin = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
    : undefined; // undefined = allow all (dev); set CORS_ORIGIN in production
app.use(cors({
    origin: corsOrigin,
    credentials: true,
}));

app.use(express.json());

// Global rate limiter — 200 requests/minute per IP
const globalLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api/', globalLimiter);

// File upload configuration — disk storage to avoid OOM on large uploads
const uploadDir = path.join(os.tmpdir(), 'soundraft-uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const upload = multer({
    storage: multer.diskStorage({
        destination: uploadDir,
        filename: (_req, file, cb) => {
            const uniqueSuffix = crypto.randomBytes(8).toString('hex');
            cb(null, `${uniqueSuffix}-${file.originalname}`);
        },
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

// Database Connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// MinIO Client (S3 Compatible) — parse S3_ENDPOINT for flexible configuration
function parseMinioConfig() {
    const endpoint = process.env.S3_ENDPOINT || 'http://storage:9000';
    try {
        const url = new URL(endpoint);
        return {
            endPoint: url.hostname,
            port: parseInt(url.port) || (url.protocol === 'https:' ? 443 : 9000),
            useSSL: url.protocol === 'https:',
        };
    } catch {
        return { endPoint: 'storage', port: 9000, useSSL: false };
    }
}

const minioConfig = parseMinioConfig();
const minioClient = new Minio.Client({
    ...minioConfig,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY
});

const BUCKET_NAME = process.env.S3_BUCKET || 'tracks';

// Input sanitization — strip HTML tags from plaintext user input
function sanitizeText(input) {
    if (typeof input !== 'string') return input;
    return input.replace(/<[^>]*>/g, '').trim();
}

// --- Startup: Ensure bucket exists and seed admin ---
async function initialize() {
    // Create MinIO bucket if it doesn't exist
    try {
        const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
        if (!bucketExists) {
            await minioClient.makeBucket(BUCKET_NAME);
            console.log(`Created bucket: ${BUCKET_NAME}`);
        } else {
            console.log(`Bucket exists: ${BUCKET_NAME}`);
        }
    } catch (err) {
        console.error('MinIO bucket error:', err.message);
    }

    // Seed admin user if not exists
    let adminUserId;
    try {
        const adminEmail = process.env.ADMIN_EMAIL;
        const adminPassword = process.env.ADMIN_PASSWORD;

        if (adminEmail && adminPassword) {
            const existing = await pool.query(
                'SELECT id FROM users WHERE email = $1',
                [adminEmail]
            );

            if (existing.rows.length === 0) {
                const hash = await bcrypt.hash(adminPassword, 10);
                const result = await pool.query(
                    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
                    [adminEmail, hash, 'ADMIN']
                );
                adminUserId = result.rows[0].id;
                console.log(`Admin user created: ${adminEmail}`);
            } else {
                adminUserId = existing.rows[0].id;
                console.log(`Admin user exists: ${adminEmail}`);
            }
        }
    } catch (err) {
        console.error('Admin seed error:', err.message);
    }

    // Seed example track and playlist for admin
    if (adminUserId) {
        try {
            await seedExampleContent(adminUserId);
        } catch (err) {
            console.error('Example content seed error:', err.message);
        }
    }
}

// Seed example track and playlist
async function seedExampleContent(adminUserId) {
    // Check if admin already has tracks
    const existingTracks = await pool.query(
        'SELECT id FROM tracks WHERE owner_id = $1 LIMIT 1',
        [adminUserId]
    );

    if (existingTracks.rows.length > 0) {
        console.log('Admin already has tracks, skipping example content seeding');
        return;
    }

    const seedDir = path.join(__dirname, 'seed-data');

    // Check if seed directory exists
    if (!fs.existsSync(seedDir)) {
        console.log('Seed data directory not found, skipping seeding');
        return;
    }

    // Fixed filenames and titles for seed content
    const trackFile = 'example-track.wav';
    const trackCoverFile = 'example-track-cover.jpg';
    const playlistCoverFile = 'example-playlist-cover.png';
    const trackTitle = 'Heroplanet - The Greatest Comeback of All Time';
    const playlistTitle = 'Soundtrack to the Motion Picture';

    const trackFilePath = path.join(seedDir, trackFile);
    if (!fs.existsSync(trackFilePath)) {
        console.log('Example track file not found, skipping seeding');
        return;
    }

    console.log('Seeding example content...');

    // 1. Create track
    const trackResult = await pool.query(
        'INSERT INTO tracks (owner_id, title, status) VALUES ($1, $2, $3) RETURNING id',
        [adminUserId, trackTitle, 'WIP']
    );
    const trackId = trackResult.rows[0].id;
    console.log(`Created track: ${trackTitle}`);

    // 2. Upload track audio file
    const trackBuffer = fs.readFileSync(trackFilePath);
    const trackStorageKey = `tracks/${trackId}/versions/${crypto.randomBytes(16).toString('hex')}.wav`;

    await minioClient.putObject(BUCKET_NAME, trackStorageKey, trackBuffer, {
        'Content-Type': 'audio/wav'
    });

    // Get audio duration (simplified - just set a placeholder)
    const durationSeconds = 180; // 3 minutes placeholder

    // Create version
    const versionResult = await pool.query(
        'INSERT INTO track_versions (track_id, version_number, filename, storage_key, mime_type, size_bytes, duration_seconds) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
        [trackId, 1, trackFile, trackStorageKey, 'audio/wav', trackBuffer.length, durationSeconds]
    );
    const versionId = versionResult.rows[0].id;

    // Set as current version
    await pool.query(
        'UPDATE tracks SET current_version_id = $1 WHERE id = $2',
        [versionId, trackId]
    );
    console.log(`Uploaded track audio file`);

    // 3. Upload track cover art
    const trackCoverPath = path.join(seedDir, trackCoverFile);
    if (fs.existsSync(trackCoverPath)) {
        const coverBuffer = fs.readFileSync(trackCoverPath);
        const coverStorageKey = `tracks/${trackId}/cover.jpg`;

        await minioClient.putObject(BUCKET_NAME, coverStorageKey, coverBuffer, {
            'Content-Type': 'image/jpeg'
        });

        await pool.query(
            'UPDATE tracks SET cover_art_path = $1 WHERE id = $2',
            [`/api/storage/${coverStorageKey}`, trackId]
        );
        console.log(`Uploaded track cover art`);
    }

    // 4. Create playlist
    const playlistResult = await pool.query(
        'INSERT INTO playlists (owner_id, title, type) VALUES ($1, $2, $3) RETURNING id',
        [adminUserId, playlistTitle, 'ALBUM']
    );
    const playlistId = playlistResult.rows[0].id;
    console.log(`Created playlist: ${playlistTitle}`);

    // 5. Add track to playlist
    await pool.query(
        'INSERT INTO playlist_tracks (playlist_id, track_id, sort_order) VALUES ($1, $2, $3)',
        [playlistId, trackId, 0]
    );
    console.log(`Added track to playlist`);

    // 6. Upload playlist cover art
    const playlistCoverPath = path.join(seedDir, playlistCoverFile);
    if (fs.existsSync(playlistCoverPath)) {
        const playlistCoverBuffer = fs.readFileSync(playlistCoverPath);
        const playlistCoverStorageKey = `playlists/${playlistId}/cover.png`;

        await minioClient.putObject(BUCKET_NAME, playlistCoverStorageKey, playlistCoverBuffer, {
            'Content-Type': 'image/png'
        });

        await pool.query(
            'UPDATE playlists SET cover_art_path = $1 WHERE id = $2',
            [`/api/storage/${playlistCoverStorageKey}`, playlistId]
        );
        console.log(`Uploaded playlist cover art`);
    }

    console.log('Example content seeding completed successfully!');
}

// --- Routes ---
const authRoutes = require('./routes/auth')(pool);
const trackRoutes = require('./routes/tracks')(pool, minioClient, BUCKET_NAME, upload);
const playlistRoutes = require('./routes/playlists')(pool, minioClient, BUCKET_NAME, upload);
const attachmentRoutes = require('./routes/attachments')(pool, minioClient, BUCKET_NAME, upload);
const commentRoutes = require('./routes/comments')(pool);
const adminRoutes = require('./routes/admin')(pool);
const reactionRoutes = require('./routes/reactions')(pool);
const exportRoutes = require('./routes/export')(pool, minioClient, BUCKET_NAME, upload);

app.use('/api/auth', authRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reactions', reactionRoutes);
app.use('/api/export', exportRoutes);

// --- Health Check ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Storage Endpoint (for cover art, etc.) ---
// V2: Hardened — removed SVG from MIME map, added nosniff + sandbox headers
app.get('/api/storage/*', async (req, res) => {
    try {
        // Extract storage key from path (everything after /api/storage/)
        const storageKey = req.params[0];

        if (!storageKey) {
            return res.status(400).send('Invalid storage key');
        }

        // Get object from MinIO
        const stat = await minioClient.statObject(BUCKET_NAME, storageKey);

        // Determine content type from file extension if not in metadata
        let contentType = stat.metaData?.['content-type'] || stat.metaData?.['Content-Type'];
        if (!contentType) {
            // Infer from file extension — SVG intentionally excluded (XSS risk)
            const ext = storageKey.split('.').pop()?.toLowerCase();
            const mimeTypes = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'mp3': 'audio/mpeg',
                'wav': 'audio/wav',
                'pdf': 'application/pdf',
            };
            contentType = mimeTypes[ext] || 'application/octet-stream';
        }

        // V2: Force safe content type for potentially dangerous stored types
        if (contentType === 'image/svg+xml' || contentType === 'text/html') {
            contentType = 'application/octet-stream';
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', 'sandbox');

        const dataStream = await minioClient.getObject(BUCKET_NAME, storageKey);
        dataStream.pipe(res);
    } catch (err) {
        if (err.code === 'NoSuchKey') {
            return res.status(404).send('File not found');
        }
        console.error('Storage fetch error:', err);
        res.status(500).send('Error fetching file');
    }
});

// --- CRITICAL: Audio Streaming Endpoint ---
// V1: Added authorization — must be track owner or have valid share token
// Handles Range headers to allow seeking in the frontend player
const { optionalAuth } = require('./middleware/auth');

app.get('/api/stream/:versionId', optionalAuth, async (req, res) => {
    try {
        const { versionId } = req.params;

        // 1. Fetch file metadata + track ownership from DB
        const result = await pool.query(
            `SELECT tv.storage_key, tv.mime_type, tv.size_bytes,
                    t.owner_id, t.share_token, t.release_status
             FROM track_versions tv
             JOIN tracks t ON tv.track_id = t.id
             WHERE tv.id = $1`,
            [versionId]
        );

        if (result.rows.length === 0) {
            return res.status(404).send('File not found');
        }

        const file = result.rows[0];

        // 2. Authorization check: owner, or valid share token + public
        const isOwner = req.user && req.user.id === file.owner_id;
        const shareToken = req.query.token;
        const hasValidShare = shareToken && shareToken === file.share_token
                              && file.release_status === 'PUBLIC';

        if (!isOwner && !hasValidShare) {
            return res.status(403).send('Access denied');
        }

        const stat = await minioClient.statObject(BUCKET_NAME, file.storage_key);
        const fileSize = stat.size;
        const range = req.headers.range;

        // 3. Handle Range Request (Seeking)
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunksize = (end - start) + 1;

            const headers = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunksize,
                'Content-Type': file.mime_type,
            };

            res.writeHead(206, headers);

            const dataStream = await minioClient.getPartialObject(
                BUCKET_NAME,
                file.storage_key,
                start,
                chunksize
            );
            dataStream.pipe(res);

        } else {
            // 4. Handle Full Download
            const headers = {
                'Content-Length': fileSize,
                'Content-Type': file.mime_type,
            };
            res.writeHead(200, headers);
            const dataStream = await minioClient.getObject(BUCKET_NAME, file.storage_key);
            dataStream.pipe(res);
        }

    } catch (err) {
        console.error("Streaming error:", err);
        res.status(500).send('Error streaming audio');
    }
});

// --- Database Migration Runner ---
async function runMigrations() {
    try {
        // Create migrations tracking table if not exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                id SERIAL PRIMARY KEY,
                filename VARCHAR(255) UNIQUE NOT NULL,
                applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const migrationsDir = path.join(__dirname, 'db', 'migrations');
        if (!fs.existsSync(migrationsDir)) return;

        const files = fs.readdirSync(migrationsDir)
            .filter(f => f.endsWith('.sql'))
            .sort();

        for (const file of files) {
            const { rows } = await pool.query(
                'SELECT 1 FROM schema_migrations WHERE filename = $1',
                [file]
            );
            if (rows.length === 0) {
                const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
                await pool.query(sql);
                await pool.query(
                    'INSERT INTO schema_migrations (filename) VALUES ($1)',
                    [file]
                );
                console.log(`Migration applied: ${file}`);
            }
        }
    } catch (err) {
        console.error('Migration error:', err.message);
    }
}

// --- Open Graph Meta Tags for Share Links ---
// Bot user-agents that request link previews
const BOT_UA_PATTERNS = [
    'facebookexternalhit', 'twitterbot', 'slackbot', 'linkedinbot',
    'whatsapp', 'telegrambot', 'discordbot', 'applebot', 'googlebot',
    'bingbot', 'iframely',
];

function isBot(userAgent) {
    if (!userAgent) return false;
    const ua = userAgent.toLowerCase();
    return BOT_UA_PATTERNS.some(bot => ua.includes(bot));
}

async function handleShareOgTags(req, res, next) {
    if (!isBot(req.headers['user-agent'])) return next();

    const { type, token } = req.params;
    if (!token || !['track', 'playlist'].includes(type)) return next();

    try {
        let title, description, imageUrl, audioUrl;
        const baseUrl = `${req.protocol}://${req.get('host')}`;

        if (type === 'track') {
            const result = await pool.query(`
                SELECT t.title, t.artist, t.cover_art_path, t.status,
                       tv.duration_seconds, tv.id as version_id
                FROM tracks t
                LEFT JOIN track_versions tv ON t.current_version_id = tv.id
                WHERE t.share_token = $1 AND t.release_status = 'PUBLIC'
            `, [token]);
            if (result.rows.length === 0) return next();
            const track = result.rows[0];
            title = track.title;
            description = [track.artist, track.status].filter(Boolean).join(' - ');
            imageUrl = track.cover_art_path ? `${baseUrl}${track.cover_art_path}` : null;
            audioUrl = track.version_id ? `${baseUrl}/api/stream/${track.version_id}?token=${token}` : null;
        } else {
            const result = await pool.query(`
                SELECT p.title, p.artist, p.type, p.cover_art_path,
                       COUNT(pt.track_id) as track_count
                FROM playlists p
                LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id
                WHERE p.share_token = $1 AND p.is_public = true
                GROUP BY p.id
            `, [token]);
            if (result.rows.length === 0) return next();
            const playlist = result.rows[0];
            title = playlist.title;
            description = [playlist.artist, `${playlist.track_count} tracks`, playlist.type].filter(Boolean).join(' - ');
            imageUrl = playlist.cover_art_path ? `${baseUrl}${playlist.cover_art_path}` : null;
        }

        const ogHtml = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>${title} - SoundRaft</title>
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description || 'Shared on SoundRaft'}">
<meta property="og:type" content="${type === 'track' ? 'music.song' : 'music.playlist'}">
<meta property="og:url" content="${baseUrl}/share/${type}/${token}">
${imageUrl ? `<meta property="og:image" content="${imageUrl}">` : ''}
${audioUrl ? `<meta property="og:audio" content="${audioUrl}">` : ''}
<meta name="twitter:card" content="${imageUrl ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description || 'Shared on SoundRaft'}">
${imageUrl ? `<meta name="twitter:image" content="${imageUrl}">` : ''}
</head><body></body></html>`;
        return res.send(ogHtml);
    } catch (err) {
        console.error('OG tag error:', err.message);
        return next();
    }
}

// --- Serve Built Frontend (production) ---
const frontendPath = path.join(__dirname, 'public');
if (fs.existsSync(frontendPath)) {
    app.use(express.static(frontendPath));

    // OG meta tags for shared links (bots only)
    app.get('/share/:type/:token', handleShareOgTags);

    // SPA fallback: serve index.html for any non-API route
    app.get('*', (req, res) => {
        if (!req.path.startsWith('/api/')) {
            res.sendFile(path.join(frontendPath, 'index.html'));
        }
    });
}

// Export for route modules
module.exports = { app, pool, minioClient, BUCKET_NAME, sanitizeText };

// Start server
runMigrations().then(() => initialize()).then(() => {
    app.listen(PORT, () => {
        console.log(`SoundRaft API running on port ${PORT}`);
    });
});
