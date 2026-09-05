'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const context = new AsyncLocalStorage();
const active = new Set();
let draining = false;

function assertRequestActive() {
    if (context.getStore()?.controller.signal.aborted) {
        throw Object.assign(new Error('Request cancelled; please retry'), { statusCode: 408 });
    }
}

function requestLifecycle(req, res, next) {
    if (draining && req.path !== '/api/live') return res.status(503).set('Connection', 'close').json({ error: 'Server restarting; please retry' });
    const state = { controller: new AbortController(), pending: 0, closed: false, releases: [] };
    req.requestId = randomUUID();
    state.requestId = req.requestId;
    res.setHeader('X-Request-ID', req.requestId);
    active.add(state);
    state.finish = () => {
        if (!state.closed || state.pending) return;
        active.delete(state);
        for (const release of state.releases.splice(0)) release();
    };
    const started = performance.now();
    res.once('close', () => {
        state.closed = true;
        if (!res.writableFinished) state.controller.abort();
        state.finish();
        // Never log URLs, query strings, headers, request bodies or identities.
        if (process.env.REQUEST_LOGGING === 'true') console.log(JSON.stringify({ event: 'request', request_id: req.requestId,
            method: req.method, status: res.statusCode, duration_ms: Math.round(performance.now() - started) }));
    });
    req.once('aborted', () => state.controller.abort());
    context.run(state, next);
}

function capacity(maximum, label) {
    let count = 0;
    return (req, res, next) => {
        if (count >= maximum) return res.status(503).set('Retry-After', '5').json({ error: `${label} capacity reached; please retry` });
        count++;
        let released = false;
        const release = () => { if (!released) { released = true; count--; } };
        const state = context.getStore();
        if (state) state.releases.push(release);
        else res.once('close', release);
        next();
    };
}

// Native transport cancellation covers DNS/connect, request upload and response
// consumption. Per-request signal also cancels subsequent multipart requests.
function storageTransport(secure, timeoutMs = Number(process.env.STORAGE_TIMEOUT_MS || 30_000)) {
    const transport = require(secure ? 'node:https' : 'node:http');
    return { request(options, callback) {
        const signal = context.getStore()?.controller.signal;
        const request = transport.request({ ...options, ...(signal ? { signal } : {}) }, callback);
        const timer = setTimeout(() => request.destroy(Object.assign(new Error('Storage operation timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
        timer.unref();
        request.once('close', () => clearTimeout(timer));
        return request;
    } };
}

async function shutdown(server, pool, reconciler, timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS || 30_000)) {
    draining = true;
    const stopped = reconciler.stop();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    const timer = setTimeout(() => {
        for (const state of active) state.controller.abort();
        server.closeAllConnections();
    }, timeoutMs);
    try {
        await closed;
        await stopped;
        // Async route cleanup can outlive the response socket.
        while (active.size) await new Promise(resolve => setTimeout(resolve, 20));
        await pool.end();
    } finally { clearTimeout(timer); }
}

module.exports = { context, requestLifecycle, assertRequestActive, capacity, storageTransport, shutdown, isDraining: () => draining };
