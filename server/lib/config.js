'use strict';

const REQUIRED = [
    'DATABASE_URL',
    'JWT_SECRET',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
];

const KNOWN_WEAK_SECRETS = new Set([
    'dev_secret_key',
    'dev_secret_key_change_in_prod',
    'dev_secret_key_change_in_prod_use_random_string',
    'dev_secret_change_me',
    'secret',
    'changeme',
    'admin',
    'minioadmin',
    'soundraft',
]);

function assertStrong(name, value, minimumLength) {
    if (value.length < minimumLength || KNOWN_WEAK_SECRETS.has(value.toLowerCase())) {
        throw new Error(`${name} must be at least ${minimumLength} characters and must not use a known default`);
    }
}

function validateResourceGrantTtl(value = '1h') {
    const match = String(value).match(/^([1-9][0-9]*)(s|m|h)$/);
    if (!match) {
        throw new Error('RESOURCE_GRANT_TTL must use seconds, minutes, or hours (for example, 1h)');
    }

    const multipliers = { s: 1, m: 60, h: 3600 };
    const seconds = Number(match[1]) * multipliers[match[2]];
    if (seconds > 24 * 60 * 60) {
        throw new Error('RESOURCE_GRANT_TTL must not exceed 24 hours');
    }
}

function validateConfig(env = process.env) {
    const missing = REQUIRED.filter(name => !env[name]);
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }

    assertStrong('JWT_SECRET', env.JWT_SECRET, 32);
    assertStrong('ADMIN_PASSWORD', env.ADMIN_PASSWORD, 12);
    assertStrong('S3_ACCESS_KEY', env.S3_ACCESS_KEY, 12);
    assertStrong('S3_SECRET_KEY', env.S3_SECRET_KEY, 16);
    validateResourceGrantTtl(env.RESOURCE_GRANT_TTL);
    for (const key of ['AUDIO_UPLOAD_MAX_BYTES', 'ATTACHMENT_UPLOAD_MAX_BYTES', 'COVER_UPLOAD_MAX_BYTES',
        'USER_STORAGE_QUOTA_BYTES', 'OBJECT_RECONCILE_INTERVAL_MS', 'OBJECT_RECONCILE_BATCH_SIZE',
        'DB_POOL_SIZE', 'DB_ACQUIRE_TIMEOUT_MS', 'DB_STATEMENT_TIMEOUT_MS', 'DB_TRANSACTION_IDLE_TIMEOUT_MS',
        'SHUTDOWN_TIMEOUT_MS', 'STORAGE_TIMEOUT_MS', 'UPLOAD_TIMEOUT_MS', 'MAX_CONCURRENT_UPLOADS', 'MAX_CONCURRENT_EXPORTS', 'MAX_EXPORT_ENTRIES',
        'OBJECT_STAGE_TTL_MINUTES', 'EXPORT_QUERY_TIMEOUT_MS', 'EXPORT_TIMEOUT_MS']) {
        if (env[key] !== undefined && (!Number.isSafeInteger(Number(env[key])) || Number(env[key]) <= 0)) {
            throw new Error(`${key} must be a positive integer`);
        }
    }

    return true;
}

module.exports = { KNOWN_WEAK_SECRETS, validateConfig, validateResourceGrantTtl };
