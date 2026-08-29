'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..');
const envPath = path.join(repositoryRoot, '.env');

if (!fs.existsSync(envPath)) {
    throw new Error(`Missing ${envPath}; copy .env.example to .env first`);
}

const replacements = {
    JWT_SECRET: crypto.randomBytes(64).toString('hex'),
    ADMIN_PASSWORD: crypto.randomBytes(24).toString('base64url'),
    DB_PASSWORD: crypto.randomBytes(24).toString('base64url'),
    S3_ACCESS_KEY: `SR${crypto.randomBytes(9).toString('hex')}`,
    S3_SECRET_KEY: crypto.randomBytes(32).toString('base64url'),
};

const original = fs.readFileSync(envPath, 'utf8');
const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
const seen = new Set();
const lines = original.split(/\r?\n/).map(line => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !Object.hasOwn(replacements, match[1])) return line;
    const name = match[1];
    seen.add(name);
    return `${name}=${replacements[name]}`;
});

for (const [name, value] of Object.entries(replacements)) {
    if (!seen.has(name)) lines.push(`${name}=${value}`);
}

fs.writeFileSync(envPath, lines.join(lineEnding), { mode: 0o600 });
console.log('Rotated JWT, administrator, PostgreSQL, and object-storage secrets in .env.');
console.log('No secret values were printed.');
