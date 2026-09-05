const { logError } = require('./lib/logging');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('./lib/postgres');
const Minio = require('minio');
const bcrypt = require('bcrypt');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { validateConfig } = require('./lib/config');
const { storageUrl, streamUrl, verifyGrant } = require('./lib/grants');
const { setAuthPool } = require('./middleware/auth');
const { createObjectReconciler } = require('./lib/object-lifecycle');
const { requestLifecycle, capacity, storageTransport, shutdown, isDraining } = require('./lib/lifecycle');

const app = express();
const PORT = process.env.PORT || 8080;

// Trust the first proxy hop (Caddy, nginx, etc.) so req.protocol reflects
// X-Forwarded-Proto and OG meta URLs use https:// on proxied deployments.
app.set('trust proxy', process.env.TRUST_PROXY ? process.env.TRUST_PROXY.split(',').map(value => value.trim()) : false);
app.use(requestLifecycle);

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
    : false; // Disabled by default; same-origin browser requests do not need CORS.
app.use(cors({
    origin: corsOrigin,
    credentials: true,
}));

app.use(express.json());

// Global rate limiter — 200 requests/minute per IP
const globalLimiter = rateLimit({
    skip: req => ['/live', '/ready', '/health'].includes(req.path) || /^\/(stream|storage)\//.test(req.path),
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down.' },
});
app.use('/api/', globalLimiter);
const uploadCapacity = capacity(Number(process.env.MAX_CONCURRENT_UPLOADS || 4), 'Upload');
const exportCapacity = capacity(Number(process.env.MAX_CONCURRENT_EXPORTS || 2), 'Export');
app.use('/api', (req, res, next) => req.method === 'POST' && req.is('multipart/form-data') ? uploadCapacity(req, res, next) : next());
app.use('/api/export/library', exportCapacity);

// File upload configuration — disk storage to avoid OOM on large uploads
const uploadDir = path.join(os.tmpdir(), 'soundraft-uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}
const uploadStorage = multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => {
        const uniqueSuffix = crypto.randomBytes(8).toString('hex');
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
        cb(null, `${uniqueSuffix}-${safeName}`);
    },
});
function createUpload(fileSize, fields = 0) {
    return multer({
        storage: uploadStorage,
        limits: {
            fileSize,
            files: 1,
            fields,
            // Busboy emits partsLimit as soon as the limit is reached, including
            // the permitted final file. Keep a sentinel slot; files/fields still
            // enforce the exact accepted multipart shape.
            parts: fields + 2,
            fieldNameSize: 100,
            fieldSize: 64 * 1024,
        },
    });
}
const uploads = {
    audio: createUpload(Number(process.env.AUDIO_UPLOAD_MAX_BYTES || 500 * 1024 * 1024)),
    attachment: createUpload(Number(process.env.ATTACHMENT_UPLOAD_MAX_BYTES || 500 * 1024 * 1024)),
    cover: createUpload(Number(process.env.COVER_UPLOAD_MAX_BYTES || 20 * 1024 * 1024)),
};

// Database Connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DB_POOL_SIZE || 10),
    connectionTimeoutMillis: Number(process.env.DB_ACQUIRE_TIMEOUT_MS || 5000), idleTimeoutMillis: 30_000,
    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS || 30_000),
    idle_in_transaction_session_timeout: Number(process.env.DB_TRANSACTION_IDLE_TIMEOUT_MS || 30_000),
});
pool.on('connect', client => client.on('error', error => logError('Database connection error', error)));
pool.on('error', error => logError('Idle database connection error:', error));
setAuthPool(pool);

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
    transport: storageTransport(minioConfig.useSSL),
    retryOptions: { disableRetry: true },
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY
});

const BUCKET_NAME = process.env.S3_BUCKET || 'tracks';
const objectReconciler = createObjectReconciler(pool, minioClient, {
    intervalMs: process.env.OBJECT_RECONCILE_INTERVAL_MS,
    batchSize: process.env.OBJECT_RECONCILE_BATCH_SIZE,
    stageTtlMinutes: process.env.OBJECT_STAGE_TTL_MINUTES,
});

// --- Startup: Ensure bucket exists and seed admin ---
async function initialize() {
    // Create MinIO bucket if it doesn't exist
    const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
    if (!bucketExists) {
        await minioClient.makeBucket(BUCKET_NAME);
        console.log(`Created bucket: ${BUCKET_NAME}`);
    } else {
        console.log(`Bucket exists: ${BUCKET_NAME}`);
    }

    // Keep the configured bootstrap administrator authoritative. This makes an
    // ADMIN_PASSWORD rotation effective for an existing persistent database.
    let adminUserId;
    const adminEmail = process.env.ADMIN_EMAIL.toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD;
    const existing = await pool.query(
        'SELECT id, password_hash, role, is_active FROM users WHERE email = $1',
        [adminEmail]
    );

    if (existing.rows.length === 0) {
        const hash = await bcrypt.hash(adminPassword, 12);
        const result = await pool.query(
            'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
            [adminEmail, hash, 'ADMIN']
        );
        adminUserId = result.rows[0].id;
        console.log(`Admin user created: ${adminEmail}`);
    } else {
        const admin = existing.rows[0];
        adminUserId = admin.id;
        const passwordMatches = await bcrypt.compare(adminPassword, admin.password_hash);
        if (!passwordMatches || admin.role !== 'ADMIN' || !admin.is_active) {
            const hash = passwordMatches ? admin.password_hash : await bcrypt.hash(adminPassword, 12);
            await pool.query(
                'UPDATE users SET password_hash = $1, role = $2, is_active = true, auth_version = auth_version + 1 WHERE id = $3',
                [hash, 'ADMIN', admin.id]
            );
            console.log(`Admin user credentials synchronized: ${adminEmail}`);
        } else {
            console.log(`Admin user exists: ${adminEmail}`);
        }
    }

    // Example data is opt-in so deleting all content does not cause it to
    // reappear on the next production restart.
    if (adminUserId && process.env.SEED_EXAMPLE_CONTENT === 'true') {
        try {
            await seedExampleContent(adminUserId);
        } catch (err) {
            logError('Example content seed error:', err);
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
    await pool.query(`
        INSERT INTO storage_objects
            (storage_key, bucket, owner_id, resource_type, resource_id, state, size_bytes, mime_type, activated_at)
        VALUES ($1, $2, $3, 'TRACK_VERSION', $4, 'ACTIVE', $5, 'audio/wav', CURRENT_TIMESTAMP)
        ON CONFLICT (storage_key) DO NOTHING
    `, [trackStorageKey, BUCKET_NAME, adminUserId, versionId, trackBuffer.length]);

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
        await pool.query(`
            INSERT INTO storage_objects
                (storage_key, bucket, owner_id, resource_type, resource_id, state, size_bytes, mime_type, activated_at)
            VALUES ($1, $2, $3, 'TRACK_COVER', $4, 'ACTIVE', $5, 'image/jpeg', CURRENT_TIMESTAMP)
            ON CONFLICT (storage_key) DO NOTHING
        `, [coverStorageKey, BUCKET_NAME, adminUserId, trackId, coverBuffer.length]);
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
        await pool.query(`
            INSERT INTO storage_objects
                (storage_key, bucket, owner_id, resource_type, resource_id, state, size_bytes, mime_type, activated_at)
            VALUES ($1, $2, $3, 'PLAYLIST_COVER', $4, 'ACTIVE', $5, 'image/png', CURRENT_TIMESTAMP)
            ON CONFLICT (storage_key) DO NOTHING
        `, [playlistCoverStorageKey, BUCKET_NAME, adminUserId, playlistId, playlistCoverBuffer.length]);
        console.log(`Uploaded playlist cover art`);
    }

    console.log('Example content seeding completed successfully!');
}

// --- Routes ---
const authRoutes = require('./routes/auth')(pool);
const trackRoutes = require('./routes/tracks')(pool, minioClient, BUCKET_NAME, uploads);
const playlistRoutes = require('./routes/playlists')(pool, minioClient, BUCKET_NAME, uploads);
const attachmentRoutes = require('./routes/attachments')(pool, minioClient, BUCKET_NAME, uploads);
const commentRoutes = require('./routes/comments')(pool);
const adminRoutes = require('./routes/admin')(pool);
const reactionRoutes = require('./routes/reactions')(pool);
const exportRoutes = require('./routes/export')(pool, minioClient, BUCKET_NAME);

app.use('/api/auth', authRoutes);
app.use('/api/media', require('./routes/media')(pool));
app.use('/api/tracks', trackRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reactions', reactionRoutes);
app.use('/api/export', exportRoutes);

// --- Health Check ---
app.get('/api/live', (_req, res) => res.json({ status: 'ok' }));
app.get(['/api/health', '/api/ready'], async (_req, res) => {
    const checks = { database: false, storage: false };
    try {
        await pool.query('SELECT 1');
        checks.database = true;
        checks.storage = await minioClient.bucketExists(BUCKET_NAME);
    } catch (err) {
        logError('Readiness check failed:', err);
    }

    const ready = !isDraining() && checks.database && checks.storage;
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ok' : 'unavailable',
        checks,
        timestamp: new Date().toISOString(),
    });
});

// --- Storage Endpoint (for cover art, etc.) ---
const { parseRange, sendObject, streamFailure } = require('./lib/streaming');
// V2: Hardened — removed SVG from MIME map, added nosniff + sandbox headers
app.get('/api/storage/*', async (req, res) => {
    try {
        // Extract storage key from path (everything after /api/storage/)
        const storageKey = req.params[0];

        if (!storageKey) {
            return res.status(400).send('Invalid storage key');
        }

        if (!verifyGrant(req.query.grant, { purpose: 'storage', storage_key: storageKey })) {
            return res.status(403).send('Access denied');
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

        // Keep signed resource responses out of shared intermediary caches.
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', 'sandbox');

        await sendObject(req, res, minioClient, BUCKET_NAME, storageKey, {
            headers: { 'Content-Type': contentType, 'Content-Length': stat.size },
        });
    } catch (err) {
        logError('Storage fetch error:', err);
        streamFailure(res, err, 'Error fetching file');
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

        // 2. Authorization check: scoped grant, owner, or valid track share.
        // Playlist share pages receive version-scoped grants from the playlist
        // endpoint, so the stream route never needs the playlist token itself.
        const hasValidGrant = verifyGrant(req.query.grant, {
            purpose: 'stream',
            version_id: versionId,
        });
        const isOwner = req.user && req.user.id === file.owner_id;
        const shareToken = req.query.token;
        const hasValidShare = shareToken && shareToken === file.share_token
                              && file.release_status === 'PUBLIC';

        if (!hasValidGrant && !isOwner && !hasValidShare) {
            return res.status(403).send('Access denied');
        }

        const stat = await minioClient.statObject(BUCKET_NAME, file.storage_key);
        const fileSize = stat.size;
        const range = req.headers.range;

        const parsed = range ? parseRange(range, fileSize) : undefined;
        if (range && !parsed) {
            return res.status(416).set('Content-Range', `bytes */${fileSize}`).send('Requested range not satisfiable');
        }
        const headers = {
            'Accept-Ranges': 'bytes',
            'Content-Length': parsed ? parsed.length : fileSize,
            'Content-Type': file.mime_type,
            'Cache-Control': 'private, no-store',
        };
        if (parsed) headers['Content-Range'] = `bytes ${parsed.start}-${parsed.end}/${fileSize}`;
        await sendObject(req, res, minioClient, BUCKET_NAME, file.storage_key, { headers, range: parsed });
    } catch (err) {
        logError("Streaming error:", err);
        streamFailure(res, err, 'Error streaming audio');
    }
});

// --- Database Migration Runner ---
async function runMigrations() {
    await require('./lib/migrations').migrate(pool, path.join(__dirname, 'db', 'migrations'), BUCKET_NAME);
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

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
            title = escapeHtml(track.title);
            description = escapeHtml([track.artist, track.status].filter(Boolean).join(' - '));
            imageUrl = track.cover_art_path ? `${baseUrl}${storageUrl(track.cover_art_path)}` : null;
            audioUrl = track.version_id ? `${baseUrl}${streamUrl(track.version_id)}` : null;
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
            title = escapeHtml(playlist.title);
            description = escapeHtml([playlist.artist, `${playlist.track_count} tracks`, playlist.type].filter(Boolean).join(' - '));
            imageUrl = playlist.cover_art_path ? `${baseUrl}${storageUrl(playlist.cover_art_path)}` : null;
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
        logError('OG tag error:', err);
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
    app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api/')) return next();
        return res.sendFile(path.join(frontendPath, 'index.html'));
    });
}

// Central error mapping for middleware errors that occur before route handlers,
// especially multipart size/shape errors from Multer.
app.use((err, _req, res, _next) => {
    if (res.headersSent) return res.destroy(err);
    if (err instanceof multer.MulterError) {
        const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return res.status(status).json({ error: err.message, code: err.code });
    }

    logError('Unhandled request error:', err);
    return res.status(500).json({ error: 'Server error' });
});

async function startServer() {
    validateConfig();
    await runMigrations();
    await initialize();
    objectReconciler.start();

    const server = app.listen(PORT, () => {
        console.log(`SoundRaft API running on port ${PORT}`);
    });
    server.requestTimeout = Number(process.env.UPLOAD_TIMEOUT_MS || 900_000);
    server.headersTimeout = 15_000;
    let stopping;
    const stop = () => {
        if (!stopping) stopping = shutdown(server, pool, objectReconciler).catch(() => { process.exitCode = 1; });
        return stopping;
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    return server;
}

if (require.main === module) {
    startServer().catch(err => {
        logError('Fatal startup error:', err);
        pool.end().finally(() => {
            process.exitCode = 1;
        });
    });
}

module.exports = {
    app,
    pool,
    minioClient,
    BUCKET_NAME,
    initialize,
    runMigrations,
    startServer,
};
