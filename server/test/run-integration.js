'use strict';
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

async function main() {
    let database, directory;
    try {
        if (!process.env.TEST_DATABASE_URL) {
            const { default: EmbeddedPostgres } = await import('embedded-postgres');
            directory = await fs.mkdtemp(path.join(os.tmpdir(), 'soundraft-pg-test-'));
            const socket = net.createServer();
            await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
            const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
            database = new EmbeddedPostgres({ databaseDir: path.join(directory, 'data'), user: 'postgres', password: 'test-only-password',
                port, persistent: true, postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
            await database.initialise(); await database.start(); await database.createDatabase('soundraft_test');
            process.env.TEST_DATABASE_URL = `postgresql://postgres:test-only-password@127.0.0.1:${port}/soundraft_test`;
        }
        await require('./integration').run();
        console.log('Integration assertions completed; cleaning up the isolated database.');
    } finally {
        if (database) await database.stop();
        if (directory && path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('soundraft-pg-test-')) {
            await fs.rm(directory, { recursive: true, force: true });
        }
    }
}
main().then(() => { console.log('Integration cleanup completed.'); process.exit(0); }, error => { console.error(error); process.exit(1); });
