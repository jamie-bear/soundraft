'use strict';
const { context } = require('./lifecycle');
function logError(event, error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'ERROR';
    console.error(JSON.stringify({ event: String(event).slice(0, 80), code, request_id: context.getStore()?.requestId }));
}
module.exports = { logError };
