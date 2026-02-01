const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Minio = require('minio');
const bcrypt = require('bcrypt');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// File upload configuration
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 * 1024 } // 500MB limit
});

// Database Connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// MinIO Client (S3 Compatible)
const minioClient = new Minio.Client({
    endPoint: 'storage',
    port: 9000,
    useSSL: false,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY
});

const BUCKET_NAME = process.env.S3_BUCKET || 'tracks';

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
                await pool.query(
                    'INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3)',
                    [adminEmail, hash, 'ADMIN']
                );
                console.log(`Admin user created: ${adminEmail}`);
            } else {
                console.log(`Admin user exists: ${adminEmail}`);
            }
        }
    } catch (err) {
        console.error('Admin seed error:', err.message);
    }
}

// --- Routes ---
const authRoutes = require('./routes/auth')(pool);
const trackRoutes = require('./routes/tracks')(pool, minioClient, BUCKET_NAME, upload);
const playlistRoutes = require('./routes/playlists')(pool, minioClient, BUCKET_NAME, upload);
const attachmentRoutes = require('./routes/attachments')(pool, minioClient, BUCKET_NAME, upload);
const commentRoutes = require('./routes/comments')(pool);
const adminRoutes = require('./routes/admin')(pool);
const reactionRoutes = require('./routes/reactions')(pool);

app.use('/api/auth', authRoutes);
app.use('/api/tracks', trackRoutes);
app.use('/api/playlists', playlistRoutes);
app.use('/api/attachments', attachmentRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/reactions', reactionRoutes);

// --- Health Check ---
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// --- Storage Endpoint (for cover art, etc.) ---
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
            // Infer from file extension
            const ext = storageKey.split('.').pop()?.toLowerCase();
            const mimeTypes = {
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'png': 'image/png',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'svg': 'image/svg+xml',
                'mp3': 'audio/mpeg',
                'wav': 'audio/wav',
                'pdf': 'application/pdf',
            };
            contentType = mimeTypes[ext] || 'application/octet-stream';
        }
        
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
        
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
// Handles Range headers to allow seeking in the frontend player
app.get('/api/stream/:versionId', async (req, res) => {
    try {
        const { versionId } = req.params;

        // 1. Fetch file metadata from DB
        const result = await pool.query(
            'SELECT storage_key, mime_type, size_bytes FROM track_versions WHERE id = $1',
            [versionId]
        );

        if (result.rows.length === 0) {
            return res.status(404).send('File not found');
        }

        const file = result.rows[0];
        const stat = await minioClient.statObject(BUCKET_NAME, file.storage_key);
        const fileSize = stat.size;
        const range = req.headers.range;

        // 2. Handle Range Request (Seeking)
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
            // 3. Handle Full Download
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

// Export for route modules
module.exports = { app, pool, minioClient, BUCKET_NAME };

// Start server
initialize().then(() => {
    app.listen(PORT, () => {
        console.log(`SoundRaft API running on port ${PORT}`);
    });
});
