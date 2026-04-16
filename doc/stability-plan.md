# Stability Improvement Plan

## Scope
This plan focuses on backend reliability and error-handling paths that can affect playback, uploads, and service startup consistency.

## Findings from code audit
1. **Audio range parsing accepted malformed values** in `/api/stream/:versionId`, which could trigger invalid partial-object reads.
2. **Object stream failures were not handled** for storage and stream endpoints, risking abrupt socket termination without consistent responses.
3. **Database migrations were not atomic per file**, so partial migration execution could leave schema and migration history out of sync.

## Changes implemented in this pass
1. Added strict `Range` header parsing with HTTP 416 responses for invalid/unsatisfiable byte ranges.
2. Added stream-level error handlers to storage and audio endpoints to improve fault handling when MinIO streams fail mid-response.
3. Wrapped each migration file execution in a transaction (`BEGIN/COMMIT/ROLLBACK`) before recording migration history.

## Next improvements (recommended)
1. Add integration tests for streaming behavior:
   - valid ranges (`bytes=0-`, `bytes=100-200`, `bytes=-500`)
   - invalid ranges (`bytes=abc-def`, start beyond file size)
2. Add request timeouts/circuit breakers for MinIO and database calls to avoid prolonged request hangs.
3. Add structured logging (request id, user id, endpoint, latency, error class) for production debugging.
4. Add health-check sub-statuses (database/minio reachable) to surface dependency failures.
5. Add retry-safe idempotency for upload/finalize endpoints to improve resilience on transient network failures.
