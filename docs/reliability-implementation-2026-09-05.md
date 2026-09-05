# Reliability implementation

Implements the follow-up packages in [the September 5 review](reliability-review-2026-09-05.md). The earlier review remains a historical record. No deployed credentials, production data, remote branches, or running deployment were changed.

## Implemented behavior

| Package | Changes | Verification |
| --- | --- | --- |
| R1 | PostgreSQL 15 + real MinIO integration in CI; isolated production-image recovery job; browser journeys; storage/DB disconnect and process-kill drills; corrupt-backup and missing-object negative checks. Image publication depends on both jobs. | Local PostgreSQL 18 + real native MinIO integration passed. Chromium journeys passed. Compose recovery and container kill drills are executable but require a Docker Linux host; they have not run here. |
| R2 | SIGTERM/SIGINT drain; DB acquisition, statement and idle-transaction limits; abortable MinIO transport; bounded upload/export capacity across all routes; separate liveness/readiness; health and media requests excluded from the ordinary IP request limit. | Unit tests cover stalled HTTP transport, cancellation, capacity retention during disconnected work, and shutdown ordering. Integration covers cancellation before resource activation. |
| R3 | Authorized media renewal before expiry, when resuming/seeking, and once after load failure; queue entries retain the original track/playlist share context; position survives renewal. | Browser and HTTP checks cover owner/visitor playback, seeking, expiry, revoked sharing, and cross-owner denial. Session tokens remain in Authorization headers. |
| P1 | One bounded page per collection request; explicit Load more for libraries, playlist contents, comments, versions, attachments and pickers; dashboard fetches eight-item previews; server search/filter/sort; playlist revision cursors. | API checks cover bounded pages, search, microsecond ordering and invalidated playlist cursors. Browser checks assert the first Tracks request fetches one 50-item page. |
| P2 | Stable export DB snapshot plus a database-wide advisory retention lock; bounded concurrency, duration and entry count; admin aggregates restricted to selected users; repeatable query/RSS/latency and fixed-volume export benchmarks. | Tests verify deletion defers during export retention and incomplete ZIPs fail. The benchmark seeds 10,000 tracks and 100,000 comments and writes plans/timing/RSS to `docs/benchmarks/reliability.json`. |
| U1 | Buffering, offline, recoverable error and Retry states; processing/saving distinguished from bytes uploaded; upload cancellation; metadata/comment drafts remain mounted after failures; reorder UI updates only after persistence. Native destructive confirmations remain keyboard accessible. | Browser checks cover offline recovery, storage response failure, retry, interrupted upload, and comment-draft preservation. |
| U2 | Route code splitting, initial-route gzip budget, explicit audio formats for extensionless media URLs, named player/card controls, keyboard cover upload, mobile navigation focus/Escape handling and contrast fixes. | Production build and bundle budget pass. Automated Chromium accessibility scan reports no serious/critical findings on the tested mobile Tracks journey. A broad manual screen-reader/device audit remains a release check. |
| R4 | Request IDs and redacted structured server errors; admin deletion/staging/quota metrics and alert conditions; backup/restore age checker and verified restore receipts; read-only orphan inventory with reviewed quarantine and a seven-day deletion window; explicit proxy trust configuration. | Real MinIO tests verify inventory does not mutate, quarantine verifies content, a wrong manifest hash is rejected and early deletion is refused. Dependency audits report zero advisories in both lockfiles. Deployment monitoring and credential policy still need operator configuration. |

## Local verification results

- Server: 25 unit/regression tests passed; fresh-database PostgreSQL integration passed with both simulated storage and real native MinIO. The real-storage run also exercised the orphan inventory/quarantine CLI.
- Client: production build and four Chromium journeys passed. The mobile Tracks accessibility scan had zero serious/critical findings. The initial authenticated route, including its static dependencies, is **85,476 bytes gzip**, about **28% below** the review's 118.7 kB baseline (budget: 94,960 bytes).
- Representative local fixture: **10,000 tracks / 100,000 comments**, 60 first-page requests, **p95 22.3 ms / p99 24.2 ms**. The same playlist export remained **283,537 bytes** when unrelated library size doubled; sampled process RSS growth was about **56.0 MiB before / 61.2 MiB after**, below the 128 MiB gate. These in-process measurements include the HTTP test client and are not production RSS guarantees. See [the recorded artifact](benchmarks/reliability.json) for environment and query plans.
- Six recovery preflight tests, Bash syntax checks, Compose configuration validation and YAML parsing passed. Both dependency audits returned zero advisories. Remote CI and the Docker recovery/fault job remain unexecuted locally.

## Selected semantics and limits

- Sharing uses **TTL-bounded revocation**. Disabling/rotating sharing prevents new grants immediately; previously issued media grants remain valid until their original expiry. `RESOURCE_GRANT_TTL` stays at the existing one-hour default (config validation caps it at 24 hours). Already downloaded audio cannot be recalled. Test harnesses use five-second grants.
- Renewal rechecks the current owner session, or the original public share plus current playlist membership. An expired resource grant alone cannot authorize renewal. Download/export session-version revocation remains unchanged.
- Libraries default to immutable creation-time ordering, with UUID tie-breakers. `sort=newest|oldest|title`, `search` (literal title/artist substring, at most 200 characters), and `filter` (track status or playlist type) are available. Changing a query requires starting a new cursor. Concurrent title/filter edits are live updates, not a frozen library snapshot; refresh to reconcile edits. Default creation ordering avoids reorder caused by audio uploads.
- Playlist pages share one DB snapshot per request and carry a membership revision. If membership/order changes, further paging returns 409 and the UI offers Reload. Drag reorder requires the complete collection to have been loaded; partial-page reorder is rejected by the UI and the server's complete-membership contract. Load more builds a queue from loaded tracks only. No background full-library fetch occurs.
- Exports are synchronous streaming downloads, with two concurrent exports per API process by default and a 20,000-entry ceiling. Comments stream within one entry per resource. A repeatable-read transaction fixes metadata for the export; an advisory lock delays physical deletion across replicas. Metadata deletion can still commit. The lock disappears on rollback, disconnect or process death. Default export deadline is 15 minutes; an aborted export is never finalized as a valid ZIP. Sustained exports can delay deletion, which is visible in backlog alerts. Durable export jobs and list virtualization were intentionally left conditional on measured need, as the plan specifies.
- Upload capacity defaults to four requests per API process, with 500 MiB audio/attachment and 20 MiB cover ceilings. Capacity stays reserved while an async handler cleans up after a disconnect. Cancellation observed before activation rolls back the active resource; interrupted staged objects remain reclaimable. A lost response after COMMIT can still mean an upload saved successfully: refresh before retrying an ambiguous completion.
- DB defaults: 10 clients, 5-second acquisition, 30-second statements and idle transactions. Storage requests have a 30-second absolute deadline; large uploads use multipart requests. Shutdown allows 30 seconds for requests before aborting remaining connections, then waits for bounded cleanup. Compose allows 75 seconds before a hard kill. Increase budgets deliberately for slower storage; keep pool capacity above concurrent exports plus maintenance headroom.
- `TRUST_PROXY` defaults to empty (direct clients). Configure only the actual proxy addresses/CIDRs; do not use an unrestricted forwarded-header policy. `REQUEST_LOGGING=true` records generated request IDs, method, status and duration, without URLs, query strings, headers, passwords, JWTs or error bodies. Request IDs are returned as `X-Request-ID`.

## Reproduce the checks

```sh
cd server
npm ci
npm test
npm run test:integration                     # isolated temporary PostgreSQL, simulated object transport
RUN_BENCHMARK=true npm run test:integration  # fresh isolated DB, 10k/100k baseline and export budgets
npm audit --audit-level=high
cd ../client
npm ci
npm run build
npm run test:bundle
npx playwright install chromium
npm run test:browser                        # built UI, isolated PostgreSQL and simulated object transport
npm audit --audit-level=high
cd ..
python3 scripts/test_restore_validation.py
bash scripts/real-service-gate.sh           # isolated PostgreSQL 15 / MinIO / production image; requires Docker
```

To test against real object storage, run the integration command with `TEST_REAL_STORAGE=true`, `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY` and `TEST_S3_SECRET_KEY`. It refuses an existing `custom-integration-bucket`. `TEST_DATABASE_URL`, when supplied, must point to a fresh, empty database named `soundraft_test`. Never use production credentials. The local real-storage verification used the checksum-verified official MinIO `RELEASE.2025-09-07T16-13-09Z` Windows binary on loopback with disposable credentials/data. The pinned image is a reproducible test fixture, not a production security recommendation.

Benchmark budgets are configurable with `FIRST_PAGE_P95_BUDGET_MS` (300), `PAGE_RSS_GROWTH_BUDGET_BYTES` (128 MiB), `EXPORT_RSS_GROWTH_BUDGET_BYTES` (128 MiB), and `INITIAL_JS_GZIP_BUDGET` (94,960 bytes). These are regression gates, not production service-level guarantees. CI publishes only the aggregate query-plan/timing artifact; browser traces, videos, screenshots, authenticated state and recovery inventories are not uploaded.

## Operations

`GET /api/admin/operations` requires a current admin session and returns numeric metrics plus actionable alert names. Monitor deletion age/failures, stages older than their configured TTL and owners exceeding quota. Run the read-only `server/scripts/verify-storage.js` inventory periodically with restricted credentials; nonzero exit means referenced media verification failed. Send these failures to the deployment's existing alert channel.

After restore, `$RESTORE_OVERRIDE_FILE.receipt.json` records successful full inventory verification. Monitor backup and restore evidence with:

```sh
python3 scripts/check-recovery-age.py /path/to/latest-backup /path/to/targets.json.receipt.json
```

Defaults alert after 24 hours without a backup or 30 days without a verified restore. Use `--backup-hours` and `--restore-days` after the operator agrees recovery objectives. Age checking does not replace checksum or off-host restore verification.

Historical orphan cleanup is deliberately opt-in:

```sh
cd server
node scripts/orphan-inventory.js > inventory.jsonl
# Review the inventory. Record its SHA256 independently.
node scripts/orphan-inventory.js quarantine inventory.jsonl REVIEWED_SHA256 > quarantine.jsonl
# Review the receipt and wait at least seven days. Keep a separate verified backup.
node scripts/orphan-inventory.js delete quarantine.jsonl REVIEWED_RECEIPT_SHA256 > deletion.jsonl
```

Inventory is read-only. Quarantine copies and hashes objects under `_quarantine/` while retaining originals. Deletion requires the exact reviewed receipt hash, both receipt and stored quarantine object to be at least seven days old, matching bytes/ETags, and repeated DB reference checks. Quarantined copies are retained after deletion. Use a maintenance window excluding external writers for historical cleanup; the tool cannot coordinate unrelated S3 clients. A separate read-only storage identity is sufficient for inventory/verification; quarantine/deletion credentials should be short-lived, bucket-scoped and unavailable to routine monitoring.

## Remaining release evidence

Run the committed Compose recovery/fault gate on a Linux Docker host and inspect remote PostgreSQL 15 CI results before deployment. The local Docker Linux engine was unavailable, so container backup/restore round trips and container kill drills are not claimed as passed. Confirm secrets were rotated in deployed systems, encrypted off-host copies and recovery keys work, monitoring delivers alerts, proxy CIDRs match topology, and maintenance/backup arrangements cover migration 006's indexes and revision trigger. Deploy schema and API together. Manual screen-reader and additional device/browser testing, agreed production hardware, and deployment RPO/RTO remain operator acceptance work.
