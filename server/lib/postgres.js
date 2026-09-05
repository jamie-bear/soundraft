'use strict';
const pg = require('pg');
// JS Date truncates PostgreSQL microseconds. Preserve them in API cursors so
// comments neither repeat forever nor disappear between adjacent pages.
pg.types.setTypeParser(1184, value => value.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
module.exports = pg;
