'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { requestLifecycle, capacity, storageTransport, context, assertRequestActive } = require('../lib/lifecycle');
const { createRouter } = require('../lib/router');

async function serve(app, run) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try { await run(`http://127.0.0.1:${server.address().port}`); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
test('storage deadline destroys a stalled real HTTP request', async () => {
    await serve(http.createServer(() => {}), async base => {
        const transport = storageTransport(false, 30);
        const result = new Promise((resolve, reject) => {
            const req = transport.request({ hostname: new URL(base).hostname, port: new URL(base).port }, resolve); req.on('error', reject); req.end();
        });
        await assert.rejects(result, { code: 'ETIMEDOUT' });
    });
});
test('request cancellation prevents storage activation and aborts subsequent operations', async () => {
    const controller = new AbortController(); controller.abort();
    context.run({ controller }, () => assert.throws(assertRequestActive, { statusCode: 408 }));
});
test('capacity stays reserved until disconnected async work has actually settled', async () => {
    let entered, finish;
    const started = new Promise(resolve => { entered = resolve; });
    const pending = new Promise(resolve => { finish = resolve; });
    const app = express(); app.use(requestLifecycle); app.use(capacity(1, 'Test'));
    const router = createRouter(); router.get('/', async (_req, res) => { entered(); await pending; if (!res.destroyed) res.end('done'); }); app.use(router);
    await serve(app, async base => {
        const controller = new AbortController(); const first = fetch(base, { signal: controller.signal }).catch(() => {});
        await started; controller.abort(); await first;
        assert.equal((await fetch(base)).status, 503);
        finish(); await new Promise(resolve => setTimeout(resolve, 30));
        assert.equal((await fetch(base)).status, 200);
    });
});

test('shutdown drains an in-flight route before closing its database pool', async () => {
    const { shutdown } = require('../lib/lifecycle');
    let enter, finish;
    const entered = new Promise(resolve => { enter = resolve; });
    const work = new Promise(resolve => { finish = resolve; });
    const app = express(); app.use(requestLifecycle);
    const router = createRouter(); router.get('/', async (_req, res) => { enter(); await work; res.end('committed'); }); app.use(router);
    const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const response = fetch(`http://127.0.0.1:${server.address().port}`).then(res => res.text());
    await entered;
    let ended = false;
    const stopping = shutdown(server, { end: async () => { ended = true; } }, { stop: async () => {} }, 1000);
    assert.equal(ended, false);
    finish(); assert.equal(await response, 'committed'); await stopping; assert.equal(ended, true);
});
