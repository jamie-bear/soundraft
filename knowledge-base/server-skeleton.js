const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Minio = require('minio');

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// MinIO Client (S3 Compatible)
const minioClient = new Minio.Client({
    endPoint: 'storage', // Docker service name
    port: 9000,
    useSSL: false,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY
});

const BUCKET_NAME = process.env.S3_BUCKET;

// --- CRITICAL: Audio Streaming Endpoint ---
// This handles Range headers to allow seeking in the frontend player
app.get('/api/stream/:versionId', async (req, res) => {
    try {
        const { versionId } = req.params;

        // 1. Fetch file metadata from DB
        const result = await pool.query(
            'SELECT storage_key, mime_type, size_bytes FROM track_versions WHERE id = $1',
            [versionId]
        );

        if (result.rows.length === 0) return res.status(404).send('File not found');

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

            // Stream specific chunk
            const dataStream = await minioClient.getPartialObject(
                BUCKET_NAME,
                file.storage_key,
                start,
                chunksize
            );
            dataStream.pipe(res);

        } else {
            // 3. Handle Full Download (No seeking requested)
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

// --- Basic Playlist Order Logic (Pseudo-code example) ---
app.put('/api/playlists/:id/reorder', async (req, res) => {
    const { id } = req.params;
    const { trackIds } = req.body; // Array of UUIDs in new order

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Loop through and update sort_order based on array index
        // In production, use a single batched query for performance
        for (let i = 0; i < trackIds.length; i++) {
            await client.query(
                'UPDATE playlist_tracks SET sort_order = $1 WHERE playlist_id = $2 AND track_id = $3',
                [i, id, trackIds[i]]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: e.message });
    } finally {
        client.release();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
