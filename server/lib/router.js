'use strict';
const express = require('express');
const { context } = require('./lifecycle');

// Express 4 does not forward rejected async handlers to error middleware.
// Keep this at registration time, including failures before a handler's try.
function createRouter() {
    const router = express.Router();
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const register = router[method].bind(router);
        router[method] = (path, ...handlers) => register(path, ...handlers.flat().map(handler =>
            function(req, res, next) {
                const state = context.getStore();
                if (state) state.pending++;
                Promise.resolve().then(() => handler(req, res, next)).catch(next).finally(() => {
                    if (state) { state.pending--; state.finish(); }
                });
            }));
    }
    return router;
}
module.exports = { createRouter };
