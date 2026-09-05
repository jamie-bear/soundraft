'use strict';

const { pipeline } = require('node:stream');
const contentDisposition = require('content-disposition');

function parseRange(value, size) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2]) || size <= 0) return null;
    const first = match[1] ? Number(match[1]) : null;
    const last = match[2] ? Number(match[2]) : null;
    if ([first, last].some(n => n !== null && !Number.isSafeInteger(n))) return null;
    const start = first === null ? Math.max(0, size - last) : first;
    const end = first === null || last === null ? size - 1 : Math.min(last, size - 1);
    if ((first === null && last <= 0) || start >= size || end < start) return null;
    return { start, end, length: end - start + 1 };
}

// Acquire the object before committing success headers. pipeline tears down both
// ends on errors/disconnects, so a truncated object cannot look like a success.
async function sendObject(req, res, minio, bucket, key, { headers = {}, range, filename } = {}) {
    const source = range
        ? await minio.getPartialObject(bucket, key, range.start, range.length)
        : await minio.getObject(bucket, key);
    if (req.aborted || res.destroyed) {
        source.destroy();
        return;
    }
    res.status(range ? 206 : 200);
    for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
    if (filename) res.setHeader('Content-Disposition', contentDisposition(filename));
    await new Promise(resolve => pipeline(source, res, error => {
        if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error('Object stream failed:', error.message);
        resolve();
    }));
}

function streamFailure(res, error, message) {
    if (res.destroyed) return;
    if (res.headersSent) return res.destroy(error);
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Disposition');
    res.status(['NoSuchKey', 'NotFound'].includes(error.code) ? 404 : 502).type('text/plain').send(message);
}

module.exports = { parseRange, sendObject, streamFailure };
