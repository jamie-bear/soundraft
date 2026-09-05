'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

exports.run = async ({ pool, base, api, userId, trackId }) => {
    await pool.query(`INSERT INTO tracks(owner_id,title,created_at)
        SELECT $1, 'Benchmark ' || lpad(n::text, 5, '0'), NOW() - n * INTERVAL '1 second' FROM generate_series(1,10000) n`, [userId]);
    for (let start = 1; start <= 100000; start += 2000) {
        await pool.query(`INSERT INTO comments(track_id,user_id,body,created_at)
            SELECT $1,$2,'Representative comment ' || n, NOW() + n * INTERVAL '1 microsecond'
            FROM generate_series($3::int,$4::int) n`, [trackId,userId,start,start+1999]);
    }
    await pool.query('ANALYZE tracks; ANALYZE comments');
    const q = require('../lib/library-query').libraryQuery({ limit: 50 }, 'track', userId);
    const plan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT t.*, tv.duration_seconds,
        tv.version_number AS current_version_number FROM tracks t LEFT JOIN track_versions tv ON t.current_version_id = tv.id
        WHERE ${q.where} ORDER BY ${q.order} LIMIT $6`, q.values);
    const commentPlan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id,body FROM comments WHERE track_id=$1 ORDER BY created_at,id LIMIT 50`, [trackId]);
    const times = [];
    const rssBefore = process.memoryUsage().rss;
    let peakRss = rssBefore;
    for (let i = 0; i < 60; i++) {
        const start = performance.now();
        const response = await api('/api/tracks?limit=50');
        assert.equal(response.status, 200);
        const page = await response.json(); assert.equal(page.tracks.length, 50); assert.ok(page.next_cursor);
        times.push(performance.now() - start); peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
    times.sort((a,b) => a-b);
    async function measureExport() {
        const grantResponse = await api('/api/export/grant', 'POST', { mode: 'playlists' });
        assert.equal(grantResponse.status, 200);
        const { url } = await grantResponse.json();
        const start = performance.now();
        const initialRss = process.memoryUsage().rss;
        let peak = initialRss;
        const sample = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
        try {
            const response = await fetch(base + url);
            assert.equal(response.status, 200);
            let bytes = 0;
            // Drain incrementally, just as a download client would.
            for await (const chunk of response.body) bytes += chunk.length;
            return { bytes, duration_ms: performance.now()-start, rss_growth_bytes: peak-initialRss };
        } finally { clearInterval(sample); }
    }
    const exportBefore = await measureExport();
    await pool.query(`INSERT INTO tracks(owner_id,title) SELECT $1, 'Unrelated '||n FROM generate_series(1,10000) n`, [userId]);
    const exportAfter = await measureExport();
    assert.equal(exportAfter.bytes, exportBefore.bytes, 'Unrelated library growth must not change playlist export volume');
    assert.ok(exportAfter.rss_growth_bytes < Number(process.env.EXPORT_RSS_GROWTH_BUDGET_BYTES || 134217728), 'Fixed-volume export memory exceeds budget');
    const result = { node: process.version, platform: process.platform, arch: process.arch, cpu: require('node:os').cpus()[0]?.model, postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
        tracks: 10000, comments: 100000, fixed_volume_export: { before: exportBefore, after_library_doubled: exportAfter }, samples: times.length, first_page_p95_ms: times[56], first_page_p99_ms: times[59],
        peak_rss_bytes: peakRss, rss_growth_bytes: peakRss-rssBefore,
        track_plan: plan.rows[0]['QUERY PLAN'], comment_plan: commentPlan.rows[0]['QUERY PLAN'] };
    // Artifacts contain query plans and aggregate timing only, never auth/URLs.
    const directory = path.resolve(process.env.BENCHMARK_OUTPUT || path.join(__dirname, '../../docs/benchmarks'));
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'reliability.json'), JSON.stringify(result, null, 2));
    assert.ok(result.first_page_p95_ms < Number(process.env.FIRST_PAGE_P95_BUDGET_MS || 300), 'First-page latency exceeds budget');
    assert.ok(result.rss_growth_bytes < Number(process.env.PAGE_RSS_GROWTH_BUDGET_BYTES || 134217728), 'Page memory growth exceeds budget');
    assert.equal((await fetch(base + '/api/live')).status, 200);
    console.log(`PASS: 10,000 tracks / 100,000 comments; first page p95 ${result.first_page_p95_ms.toFixed(1)}ms, p99 ${result.first_page_p99_ms.toFixed(1)}ms`);
};
