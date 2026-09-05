'use strict';

const fs = require('fs');

function uploadDeadline(milliseconds) {
    return (req, res, next) => {
        const timer = setTimeout(() => {
            if (!res.headersSent) res.status(408).json({ error: 'Upload timed out' });
            req.destroy();
        }, milliseconds);
        timer.unref?.();
        const clear = () => clearTimeout(timer);
        res.once('finish', clear);
        res.once('close', clear);
        next();
    };
}

function removeTempFile(file) {
    if (file?.path) fs.unlink(file.path, () => {});
}

module.exports = { removeTempFile, uploadDeadline };
