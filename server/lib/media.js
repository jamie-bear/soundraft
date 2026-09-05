'use strict';
const fs = require('node:fs/promises');
const sharp = require('sharp');
// Do not retain open file handles after processing (notably on Windows).
sharp.cache({ files: 0, memory: 16, items: 50 });

function invalid(message) { return Object.assign(new Error(message), { statusCode: 400 }); }

async function prepareCover(file) {
    const output = `${file.path}.webp`;
    try {
        const image = sharp(file.path, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' });
        const metadata = await image.metadata();
        if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format)) throw invalid('Unsupported image format');
        if (metadata.width !== (metadata.pageHeight || metadata.height)) throw invalid('Cover art must be square');
        // Bound decoded pixels and output bytes; strip metadata and flatten animation.
        await image.rotate().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 85 }).toFile(output);
        const stat = await fs.stat(output);
        if (stat.size > 6 * 1024 * 1024) throw invalid('Compressed cover exceeds 6MB');
        await fs.unlink(file.path);
        file.path = output;
        file.size = stat.size;
        file.mimetype = 'image/webp';
    } catch (error) {
        await fs.unlink(output).catch(() => {});
        if (error.statusCode) throw error;
        throw invalid('Invalid or damaged image');
    }
}

async function audioDuration(file) {
    try {
        const { parseFile } = await import('music-metadata');
        const metadata = await parseFile(file.path, { duration: true });
        if (!['MPEG', 'WAVE'].includes(metadata.format.container) || !Number.isFinite(metadata.format.duration)
            || metadata.format.duration <= 0) throw invalid('Invalid audio');
        return Math.round(metadata.format.duration);
    } catch {
        throw invalid('Invalid or unreadable MP3/WAV audio');
    }
}
module.exports = { prepareCover, audioDuration };
