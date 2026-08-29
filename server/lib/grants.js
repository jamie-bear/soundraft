'use strict';

const jwt = require('jsonwebtoken');

const GRANT_AUDIENCE = 'soundraft-resource';
const GRANT_ISSUER = 'soundraft';
const GRANT_TTL = process.env.RESOURCE_GRANT_TTL || '1h';

function secret() {
    if (!process.env.JWT_SECRET) {
        throw new Error('JWT_SECRET is required to issue resource grants');
    }
    return process.env.JWT_SECRET;
}

function issueGrant(claims) {
    return jwt.sign(
        { ...claims, token_type: 'RESOURCE_GRANT' },
        secret(),
        {
            algorithm: 'HS256',
            audience: GRANT_AUDIENCE,
            issuer: GRANT_ISSUER,
            expiresIn: GRANT_TTL,
        }
    );
}

function verifyGrant(token, expectedClaims) {
    if (!token) return false;

    try {
        const decoded = jwt.verify(token, secret(), {
            algorithms: ['HS256'],
            audience: GRANT_AUDIENCE,
            issuer: GRANT_ISSUER,
        });

        if (decoded.token_type !== 'RESOURCE_GRANT') return false;
        return Object.entries(expectedClaims).every(([key, value]) => decoded[key] === value);
    } catch {
        return false;
    }
}

function streamUrl(versionId) {
    if (!versionId) return null;
    const grant = issueGrant({ purpose: 'stream', version_id: versionId });
    return `/api/stream/${encodeURIComponent(versionId)}?grant=${encodeURIComponent(grant)}`;
}

function storageUrl(storagePath) {
    if (!storagePath) return null;
    const prefix = '/api/storage/';
    const storageKey = storagePath.startsWith(prefix)
        ? storagePath.slice(prefix.length)
        : storagePath;
    const grant = issueGrant({ purpose: 'storage', storage_key: storageKey });
    return `${prefix}${storageKey}?grant=${encodeURIComponent(grant)}`;
}

function addResourceUrls(resource) {
    if (!resource) return resource;
    return {
        ...resource,
        cover_art_path: resource.cover_art_path ? storageUrl(resource.cover_art_path) : null,
        stream_url: resource.current_version_id ? streamUrl(resource.current_version_id) : null,
    };
}

module.exports = {
    addResourceUrls,
    issueGrant,
    storageUrl,
    streamUrl,
    verifyGrant,
};
