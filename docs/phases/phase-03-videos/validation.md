---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T13:05:45-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T10:25:58-03:00"
issues:
  - id: DG-1
    status: resolved
    summary: "Owner routes need the caller's channel_id but no endpoint exposes it"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.7"
  - id: DG-2
    status: resolved
    summary: "golevelup 9.1.1 peers require @nestjs/common|core ^11.1.24"
    resolved_by: "planner 2026-11-04 → phase-03-videos.md SI-03.1"
  - id: AMB-1
    status: resolved
    summary: "Create-video request body fields and length limits undefined"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.8"
  - id: AMB-2
    status: resolved
    summary: "Allowed video content_type values not specified"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.5, SI-03.8"
  - id: AMB-3
    status: resolved
    summary: "Domain error codes for video endpoints not cataloged"
    resolved_by: "user 2026-11-04 → phase-03-videos.md Error Catalog"
  - id: AMB-4
    status: resolved
    summary: "Claim lease, sweeper interval and unclaimed grace period unspecified"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.4, SI-03.15"
  - id: AMB-5
    status: resolved
    summary: "Sweeper scheduling mechanism inside the worker not decided"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.15"
  - id: AMB-6
    status: resolved
    summary: "@Throttle override values for polled/public video routes unspecified"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.9, SI-03.11, SI-03.16"
  - id: AMB-7
    status: resolved
    summary: "complete endpoint behavior with missing parts or size mismatch unclear"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.10"
  - id: AMB-8
    status: resolved
    summary: "videos.channel_id foreign key ON DELETE behavior unspecified"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.3"
  - id: AMB-9
    status: resolved
    summary: "error_code persisted when storage fails at upload init undefined"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.4, SI-03.8"
  - id: IC-1
    status: resolved
    summary: "create-test-data-source.ts reads DB_DATABASE while config uses DB_NAME"
    resolved_by: "user 2026-11-04 → kept as-is (outside Phase 03 scope)"
  - id: IC-2
    status: resolved
    summary: "TD-07 images minio/minio and minio/mc are no longer published"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.2 (pgsty images)"
  - id: IC-3
    status: resolved
    summary: "MinIO lacks the AbortIncompleteMultipartUpload lifecycle rule (TD-07)"
    resolved_by: "planner 2026-11-04 → phase-03-videos.md SI-03.2"
  - id: IC-4
    status: resolved
    summary: "TD-01 wants uncaught errors nacked w/o requeue; golevelup default is REQUEUE"
    resolved_by: "user 2026-11-04 → phase-03-videos.md SI-03.6, SI-03.14 (NACK)"
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **DG-1** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.7)_ — Owner routes are nested under `channels/:channelId/videos` (TD-02/TD-06), but no endpoint exposed the caller's channel id. `GET /auth/me` now returns `channel_id`.
- **DG-2** _(resolved_by planner 2026-11-04 → phase-03-videos.md SI-03.1)_ — `@golevelup/nestjs-rabbitmq@9.1.1` declares peers `@nestjs/common`/`@nestjs/core` `^11.1.24 || ^12.0.0` while `nestjs-project` pins 11.1.16. The Nest packages are bumped to `^11.1.24` and the existing suite runs before any new dependency is installed.
- **AMB-1** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.8)_ — Create body: `title` (trimmed, 1–100), `original_filename` (1–255), `content_type` (allow-list) and `size_bytes` (integer ≥ 1, ≤ `STORAGE_MAX_UPLOAD_BYTES`).
- **AMB-2** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.5, SI-03.8)_ — Allow-list `video/mp4 → mp4`, `video/quicktime → mov`, `video/webm → webm`, `video/x-matroska → mkv`; the key extension comes from this map, never from the client filename.
- **AMB-3** _(resolved_by user 2026-11-04 → phase-03-videos.md Error Catalog)_ — Video domain codes are cataloged with their HTTP statuses (`VIDEO_NOT_FOUND`, `CHANNEL_NOT_FOUND`, `CHANNEL_ACCESS_DENIED`, `VIDEO_INVALID_STATE`, `UPLOAD_INCOMPLETE`, `UPLOAD_SIZE_MISMATCH`, `UPLOAD_TOO_LARGE`, `STORAGE_UNAVAILABLE`, `QUEUE_UNAVAILABLE`, …), following the `phase-02-auth/TD-07` envelope.
- **AMB-4** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.4, SI-03.15)_ — The claim lease equals `QUEUE_CONSUMER_TIMEOUT_MS`; the sweeper runs every 5 min (`SWEEP_INTERVAL_MS`) and re-publishes unclaimed `processing` rows after a 10 min grace (`UNCLAIMED_GRACE_MS`), both as code constants.
- **AMB-5** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.15)_ — Native `setInterval` started in `onApplicationBootstrap` and cleared in `beforeApplicationShutdown`; no scheduling library is added.
- **AMB-6** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.9, SI-03.11, SI-03.16)_ — `@Throttle` overrides: owner detail 60/60 s, `uploads/parts` 30/60 s, public video routes 120/60 s; the global 10/60 s limit stays for the rest.
- **AMB-7** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.10)_ — `complete` pre-checks `ListParts` (any missing part → `409 UPLOAD_INCOMPLETE`; summed size ≠ `size_bytes` → `422 UPLOAD_SIZE_MISMATCH`), then completes and post-checks `HeadObject.ContentLength`.
- **AMB-8** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.3)_ — FK `videos.channel_id → channels.id` uses `ON DELETE NO ACTION`, matching `channels.user_id`; deletion flows belong to a later phase.
- **AMB-9** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.4, SI-03.8)_ — A storage failure at upload init moves the draft to `error` with `error_code = STORAGE_UNAVAILABLE`, mirroring the 503 response code.
- **IC-1** _(resolved_by user 2026-11-04 → kept as-is (outside Phase 03 scope))_ — `create-test-data-source.ts` reads `DB_DATABASE` while `databaseConfig` uses `DB_NAME`; left unchanged in this phase.
- **IC-2** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.2 (pgsty images))_ — The official `minio/minio` and `minio/mc` images are no longer published; Compose pins `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` and `pgsty/mc:RELEASE.2026-10-26T00-00-00Z`.
- **IC-3** _(resolved_by planner 2026-11-04 → phase-03-videos.md SI-03.2)_ — MinIO does not implement the S3 `AbortIncompleteMultipartUpload` lifecycle rule required by TD-02/TD-07; the 1-day orphan cleanup uses MinIO's native `MINIO_API_STALE_UPLOADS_EXPIRY=24h`, plus the TD-06 sweeper for stale drafts.
- **IC-4** _(resolved_by user 2026-11-04 → phase-03-videos.md SI-03.6, SI-03.14 (NACK))_ — TD-01 requires an uncaught consumer error to be nacked **without** requeue, but golevelup 9.1.1 defaults `defaultSubscribeErrorBehavior` to `REQUEUE` (immediate redelivery loop up to `x-delivery-limit`, also for non-JSON bodies). Of the three behaviors, `NACK` fits Phase 03 best: `ACK` drops the evidence, `REQUEUE` hot-loops and is then dropped by the lease guard, `NACK` dead-letters once to `video.processing.dlq` while the sweeper recovers the row from the database. `QueueModule` sets `defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK`, covered by an integration test and AC in SI-03.6.
