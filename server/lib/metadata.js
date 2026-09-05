'use strict';

const { sanitizeText } = require('./text');
function validateMetadata(body, kind, creating = false) {
    if (creating || body.title !== undefined) {
        if (typeof body.title !== 'string' || !sanitizeText(body.title) || body.title.length > 255) return 'Title must contain 1-255 characters';
    }
    if (body.artist != null && (typeof body.artist !== 'string' || body.artist.length > 255)) return 'Artist must be text of at most 255 characters';
    const enums = {
        type: kind === 'track' ? ['RELEASE', 'RADIO_MIX', 'ALT_MIX'] : ['ALBUM', 'EP', 'SINGLE', 'PLAYLIST'],
        status: ['POC', 'DRAFT', 'WIP', 'FINAL'],
        release_status: ['PRIVATE', 'PUBLIC'],
        comment_access: ['PRIVATE', 'PUBLIC_VIEW', 'PUBLIC_FULL'],
    };
    for (const [key, values] of Object.entries(enums)) {
        if (body[key] !== undefined && !values.includes(body[key])) return `Invalid ${key}`;
    }
    if (body.is_public !== undefined && typeof body.is_public !== 'boolean') return 'is_public must be a boolean';
    return null;
}
module.exports = { validateMetadata };
