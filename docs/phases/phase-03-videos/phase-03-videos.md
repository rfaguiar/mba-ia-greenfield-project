---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-04T13:05:45-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-04T13:24:12-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T10:25:58-03:00"
  docs/decisions/technical-decisions-next-frontend-config-base.md: "2026-11-02T15:08:56-03:00"
  docs/decisions/technical-decisions-next-frontend-msw-foundation.md: "2026-11-02T15:08:56-03:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-11-02T15:08:56-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-02T15:08:56-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver resumable direct-to-storage uploads of videos up to 10 GiB (S3 multipart with presigned part URLs) that register a draft on start, asynchronous processing through RabbitMQ in a dedicated worker process (ffprobe metadata + ffmpeg thumbnail), a guarded `draft → processing → ready | error` lifecycle with a recovery sweeper, and public UUID-addressed endpoints that hand out presigned URLs for streaming, download and thumbnails — all running from `docker compose up` with MinIO, RabbitMQ and the worker.

---

## Step Implementations

### SI-03.1 — Dependencies and Storage/Queue/Worker Configuration Namespaces

**Description:** Clear the `@golevelup/nestjs-rabbitmq` peer-dependency gate by bumping the NestJS core packages within `^11`, install the Phase 03 libraries, and add the `storage`, `queue` and `worker` config namespaces with Joi validation following the `registerAs` pattern from Phase 01.

**Technical actions:**

- Bump `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` and `@nestjs/testing` to `^11.1.24` in nestjs-project (the lockfile pins 11.1.16; `@golevelup/nestjs-rabbitmq@9.1.1` declares peers `@nestjs/common`/`@nestjs/core` `^11.1.24 || ^12.0.0`) and run the existing suite before installing anything else (per TD-01 peer-dep gate)
- Install production dependencies: `@golevelup/nestjs-rabbitmq@^9.1.1`, `@aws-sdk/client-s3@^3.1161.0`, `@aws-sdk/s3-request-presigner@^3.1161.0` (same minor for both AWS packages); add `@types/amqplib@^0.10.x` as a devDependency only if the compiler cannot resolve `amqplib` types used in handler signatures (`ConsumeMessage`, `Options.Publish`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (internal, default `http://minio:9000`), `STORAGE_PUBLIC_ENDPOINT` (browser-reachable, default `http://localhost:9000`), `STORAGE_REGION` (default `us-east-1`), `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_FORCE_PATH_STYLE` (boolean, default `true`), `STORAGE_BUCKET_VIDEOS` (default `videos`), `STORAGE_BUCKET_THUMBNAILS` (default `thumbnails`), `STORAGE_PRESIGN_EXPIRY_SECONDS` (default `3600`), `STORAGE_MAX_UPLOAD_BYTES` (default `10737418240`), `STORAGE_PART_SIZE_BYTES` (default `67108864`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `RABBITMQ_URL`, `QUEUE_DELIVERY_LIMIT` (default `3`), `QUEUE_CONSUMER_TIMEOUT_MS` (default `7200000`), `QUEUE_RETRY_DELAY_MS` (default `30000`), `QUEUE_MAX_ATTEMPTS` (default `3`); and `src/config/worker.config.ts` — `registerAs('worker', ...)` reading `WORKER_SCRATCH_DIR` (default `/tmp/streamtube-worker`) and `VIDEO_DRAFT_TTL_HOURS` (default `24`). Register the three namespaces in `AppModule`'s `ConfigModule.forRoot({ load })`
- Extend `src/config/env.validation.ts` with every new key (`STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` and `RABBITMQ_URL` required; `STORAGE_PART_SIZE_BYTES` between 5 MiB and 5 GiB; `STORAGE_MAX_UPLOAD_BYTES` positive and ≤ `STORAGE_PART_SIZE_BYTES × 10000` via a Joi custom rule; numeric keys positive integers) and update `.env.example` with all new keys plus the Compose-only `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` (same values as the storage credentials) and `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS` (per TD-07 env inventory)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/config/env.validation.integration-spec.ts` | Unit | Required storage/queue keys rejected when missing; part size below 5 MiB rejected; max upload above `part size × 10000` rejected; defaults applied for optional keys |

**Dependencies:** None

**Acceptance criteria:**

- After the `@nestjs/*` bump, the full existing unit, integration and E2E suites still pass unchanged
- Starting the application without `STORAGE_ACCESS_KEY_ID` or `RABBITMQ_URL` fails at bootstrap with a Joi validation error naming the missing key
- Starting the application with `STORAGE_PART_SIZE_BYTES=1048576` fails at bootstrap with a Joi validation error (below the 5 MiB S3 minimum)
- `.env.example` copied to `.env` boots the application with every Phase 03 key resolved to its documented default

---

### SI-03.2 — Compose Infrastructure: MinIO, Bucket Init, RabbitMQ, Persistent Volumes and FFmpeg

**Description:** Add the S3-compatible storage, its one-shot provisioning container and the RabbitMQ broker to `nestjs-project/compose.yaml`, persist Postgres alongside them, and install FFmpeg in the shared development image so both the API container (tests) and the worker can run `ffprobe`/`ffmpeg`.

**Technical actions:**

- Add service `minio` to `nestjs-project/compose.yaml` — image pinned to `pgsty/minio:RELEASE.2026-08-04T00-00-00Z` (community-maintained drop-in fork; the official `minio/minio` image is no longer published), `command: server /data --console-address :9001`, ports `9000:9000` (S3 API) and `9001:9001` (console), env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` interpolated from `.env`, `MINIO_API_STALE_UPLOADS_EXPIRY=24h` (MinIO does not implement the S3 `AbortIncompleteMultipartUpload` lifecycle rule — this server setting is its native equivalent for the 1-day orphan cleanup required by TD-07), named volume `minio-data:/data`, healthcheck against `http://localhost:9000/minio/health/live`
- Add one-shot service `minio-init` — image pinned to `pgsty/mc:RELEASE.2026-10-26T00-00-00Z`, `depends_on: minio (service_healthy)`, entrypoint script that runs `mc alias set local http://minio:9000 ...`, `mc mb --ignore-existing local/videos local/thumbnails`, and `mc cors set local/videos` + `mc cors set local/thumbnails` with a versioned `docker/minio/cors.xml` (allow `PUT`/`GET`/`HEAD` from the frontend origin `http://localhost:3001`, allow headers `*`, expose `ETag`); the script exits 0 on success so dependants can use `condition: service_completed_successfully`
- Add service `rabbitmq` — image pinned to `rabbitmq:4.3.7-management`, fixed `hostname: rabbitmq` (the data directory is node-name bound), ports `5672:5672` and `15672:15672`, env `RABBITMQ_DEFAULT_USER`/`RABBITMQ_DEFAULT_PASS` from `.env`, named volume `rabbitmq-data:/var/lib/rabbitmq`, healthcheck `rabbitmq-diagnostics -q ping`
- Add named volume `db-data:/var/lib/postgresql/data` to the existing `db` service and declare `db-data`, `minio-data`, `rabbitmq-data` under top-level `volumes`; extend `nestjs-api.depends_on` with `minio-init` (`service_completed_successfully`) and `rabbitmq` (`service_healthy`) (per TD-07 persistence hazard: rows, objects and messages persist together)
- Add `ffmpeg` to the `apt install -y` line in `nestjs-project/Dockerfile.dev` (shared by `nestjs-api` and the future `worker`), keeping the `node:25.6.0-slim` base and `USER node`

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `docker compose up -d` from `nestjs-project/` brings `db`, `minio`, `rabbitmq` and `mailpit` to healthy/running and `minio-init` to `exited (0)`; re-running `docker compose up -d` leaves `minio-init` exiting 0 again (idempotent bucket creation)
- The MinIO console at `localhost:9001` lists buckets `videos` and `thumbnails`; an `OPTIONS` preflight from origin `http://localhost:3001` against a `videos` object URL returns `Access-Control-Expose-Headers` including `ETag`
- The RabbitMQ management UI is reachable at `localhost:15672` with the `.env` credentials
- `docker compose exec nestjs-api ffprobe -version` and `ffmpeg -version` exit 0 after rebuilding the image
- After `docker compose down` + `docker compose up -d`, rows in Postgres, objects in MinIO and RabbitMQ definitions are still present

---

### SI-03.3 — Video Entity, Status Enum and Migration

**Description:** Create the `Video` entity with the four-state media lifecycle enum and the upload/processing detail columns, relate it to `Channel` on both sides, generate the `CreateVideos` migration, and update the shared test helpers that enumerate entities and tables.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with the columns in `### Data Model → Video` (UUID v4 PK is the public URL identifier, no `public_id` column per TD-04); export `VideoStatus` enum (`draft`, `processing`, `ready`, `error`, default `draft`, Postgres enum name `videos_status_enum` per TD-06) and `VideoErrorCode` string union; map `size_bytes` (`bigint`) through a column transformer to `number` (10 GiB fits in `Number.MAX_SAFE_INTEGER`); `@ManyToOne(() => Channel, (c) => c.videos, { nullable: false })` + `@JoinColumn({ name: 'channel_id' })`, and add the inverse `@OneToMany(() => Video, (v) => v.channel) videos` to `src/channels/entities/channel.entity.ts`
- Create `src/videos/video-persistence.module.ts` — `TypeOrmModule.forFeature([Video])` exported, so the API (`VideosModule`) and the worker (`WorkerModule`) share one entity registration without the worker importing any controller
- Generate the migration via `npm run migration:generate -- src/database/migrations/CreateVideos` (never hand-written): creates `videos_status_enum`, table `videos`, FK `channel_id → channels.id` with `ON DELETE NO ACTION` (same as `channels.user_id`; deletion flows are a later phase), index on `channel_id`, and composite index `(status, created_at)` for the sweeper scans; verify `down()` drops the table, the indexes and the enum
- Create `src/test/all-entities.ts` exporting `ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video]` and replace the ten local `ALL_ENTITIES` constants in existing specs (`auth.module.spec.ts`, `users.module.spec.ts`, `channels.module.spec.ts`, and the seven entity/service `*.integration-spec.ts` files) with the shared import — the new `Channel.videos` relation makes `Video` metadata mandatory wherever `Channel` is loaded; add `DELETE FROM videos` before `channels` in `cleanAllTables` (`src/test/create-test-data-source.ts`)
- Update `src/database/migrations.integration-spec.ts` — expect three applied migrations, the `videos` table and the `videos_status_enum` type after `runMigrations()`, and both removed after reverting the last migration

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Defaults (`status = draft`, `processing_attempts = 0`, nullable detail columns null); enum rejects unknown status; FK rejects unknown `channel_id`; deleting a channel that owns videos fails (NO ACTION); `size_bytes` of 10 GiB round-trips as a number |
| `src/database/migrations.integration-spec.ts` | Integration | Three migrations applied; `videos` table and enum exist; revert removes them |

**Dependencies:** None

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with `status` typed as `videos_status_enum` defaulting to `draft`; `migration:revert` removes the table and the enum
- Inserting a video with a `channel_id` that does not exist in `channels` fails with a foreign-key violation
- Deleting a channel that still has videos fails with a foreign-key violation — no video row is orphaned or silently removed
- Inserting a video with `size_bytes = 10737418240` and reading it back yields the same numeric value
- All pre-existing integration and module specs still pass after switching to the shared `ALL_ENTITIES`

---

### SI-03.4 — VideoLifecycleService: Guarded Transitions, Lease Claim and Sweeper Queries

**Description:** Implement the single place that writes `videos.status`, enforcing every TD-06 transition with a conditional `UPDATE … WHERE status = <expected>` (no row locks), the lease-guarded worker claim, and the bounded queries the sweeper uses — shared by the API and the worker.

**Technical actions:**

- Create `src/videos/video-lifecycle.service.ts` (provided and exported by `VideoPersistenceModule`) injecting `Repository<Video>`; add `createDraft({ channelId, title, originalFilename, contentType, sizeBytes })` (INSERT, returns the row), `findOwned(channelId, videoId)` (always filters by both ids — anti-IDOR) and `findReady(videoId)` (`status = ready` only)
- Implement conditional transitions with `createQueryBuilder().update(Video).set(...).where('id = :id AND status = :expected')` returning `affected === 1` as a boolean: `attachUploadId(id, uploadId)` (draft only), `failDraft(id, errorCode, errorMessage)` (`draft → error`), `startProcessing(id)` (`draft → processing`, resets `processing_started_at = NULL` and `processing_attempts = 0`), `markReady(id, { durationSeconds, metadata })` (`processing → ready`, sets `processed_at = now()`, clears `error_*`), `failProcessing(id, errorCode, errorMessage)` (`processing → error`); every transition sets `updated_at = now()` explicitly
- Implement `claim(id, leaseMs)` as one `UPDATE … SET processing_started_at = now(), processing_attempts = processing_attempts + 1 WHERE id = :id AND status = 'processing' AND (processing_started_at IS NULL OR processing_started_at < now() - :lease * interval '1 millisecond') RETURNING *` evaluated against the database clock; returns the claimed row (with `channel_id`, `content_type`, `processing_attempts`) or `null` (lease = `QUEUE_CONSUMER_TIMEOUT_MS`, per resolved validation); add `releaseClaim(id)` (`processing` only: sets `processing_started_at = NULL`, keeps `processing_attempts`) so a TTL-delayed retry or a redelivery after a graceful shutdown can claim again without waiting for the lease to expire
- Implement bounded sweeper queries (batch of 100, oldest first): `findStaleDrafts(ttlHours)` (`draft` with `created_at < now() - ttl`), `findUnclaimedProcessing(graceMs)` (`processing`, `processing_started_at IS NULL`, `updated_at < now() - grace`), `findExpiredLeases(leaseMs)` (`processing`, `processing_started_at < now() - lease`); add `touch(id)` (bumps `updated_at` on an unclaimed `processing` row so a re-published row is not re-published again before the next grace window) and `timeoutProcessing(id, leaseMs)` (`processing → error/PROCESSING_TIMEOUT` guarded by the same expired-lease predicate so it never overrides a fresh claim)
- Define the `VideoErrorCode` values persisted in `error_code` — `INVALID_MEDIA`, `UNSUPPORTED_CODEC`, `PROCESSING_FAILED`, `PROCESSING_TIMEOUT`, `UPLOAD_EXPIRED`, `UPLOAD_ABORTED`, `UPLOAD_SIZE_MISMATCH`, `STORAGE_UNAVAILABLE` (storage failure at upload init, mirroring the 503 code) — each paired with a fixed user-safe `error_message` (never stderr, paths or SDK messages)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-lifecycle.service.spec.ts` | Unit | Each transition maps `affected` to true/false; `claim` maps empty `RETURNING` to `null`; error codes always carry the fixed user-safe message |
| `src/videos/video-lifecycle.service.integration-spec.ts` | Integration | Allowed/forbidden transitions against real Postgres; concurrent `startProcessing` and concurrent `claim` on the same row — exactly one wins; lease expiry re-enables the claim and increments attempts; sweeper queries select only qualifying rows; `findOwned` returns nothing for a video of another channel |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- Two concurrent `draft → processing` transitions on the same video result in exactly one success; the row ends in `processing` with `processing_attempts = 0`
- A transition whose expected status does not match the row (e.g., `ready → processing`, `error → processing`, abort on a `processing` row) changes nothing and reports failure
- Claiming a `processing` video whose lease is still active returns nothing and leaves `processing_attempts` unchanged; after the lease expires the claim succeeds, sets `processing_started_at` and increments `processing_attempts`
- Releasing a claim makes the video claimable again immediately while preserving its `processing_attempts`
- Two concurrent claims on the same `processing` video result in exactly one claimed row
- Marking a video ready persists `duration_seconds`, the curated `metadata`, `processed_at`, and leaves `error_code`/`error_message` null
- Looking up a video by `(channelId, videoId)` where the video belongs to a different channel returns nothing

---

### SI-03.5 — StorageModule: S3 Clients, Key Layout, Multipart and Presigning

**Description:** Provide the storage port over the official AWS SDK v3 against MinIO: an internal client for server-side calls and a presign-only client bound to the browser-reachable endpoint, the TD-07 key layout and content-type allow-list, multipart lifecycle operations, presigned URLs, and file transfer helpers for the worker.

**Technical actions:**

- Create `src/storage/storage.module.ts` with two factory providers injecting `storageConfig.KEY`: `S3_CLIENT` (`endpoint = STORAGE_ENDPOINT`) and `S3_PRESIGN_CLIENT` (`endpoint = STORAGE_PUBLIC_ENDPOINT`, used only for signing — the signature covers the host), both `new S3Client({ region, endpoint, credentials, forcePathStyle, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' })` (prevents SDK ≥ 3.729 default CRC32 checksum parameters from being baked into presigned `UploadPart` URLs, which a browser PUT cannot satisfy); export `StorageService`
- Create `src/storage/storage-keys.ts` (pure): `VIDEO_CONTENT_TYPES` allow-list map `video/mp4 → mp4`, `video/quicktime → mov`, `video/webm → webm`, `video/x-matroska → mkv`; `originalKey(channelId, videoId, contentType)` → `{channelId}/{videoId}/original.{ext}` (ext from the map, never from the client filename) in bucket `STORAGE_BUCKET_VIDEOS`; `thumbnailKey(channelId, videoId)` → `{channelId}/{videoId}/thumbnail.jpg` in bucket `STORAGE_BUCKET_THUMBNAILS` (per TD-07)
- Create `src/storage/storage.service.ts` multipart operations on the internal client: `createMultipartUpload(key, contentType)` → `UploadId`; `listUploadedParts(key, uploadId)` via `paginateListParts` (follows `NextPartNumberMarker`) → `{ partNumber, etag, size }[]`; `completeMultipartUpload(key, uploadId, parts)`; `abortMultipartUpload(key, uploadId)` (treats `NoSuchUpload` as success); `headObject(bucket, key)` → `{ contentLength }` or `null` on `NotFound`; `deleteObject(bucket, key)`
- Add presigning on the presign-only client with `getSignedUrl` from `@aws-sdk/s3-request-presigner` and `expiresIn = STORAGE_PRESIGN_EXPIRY_SECONDS`: `presignUploadParts(key, uploadId, partNumbers)` (one `UploadPartCommand` per part, signed in a single batch) and `presignGetObject(bucket, key, { responseContentDisposition? })` (`GetObjectCommand` with `ResponseContentDisposition`); both return `expiresAt` computed at signing time
- Add worker transfer helpers `downloadToFile(bucket, key, filePath)` (streams `GetObject.Body` to disk with `stream/promises.pipeline`, never buffering in memory) and `uploadFile(bucket, key, filePath, contentType)` (`PutObjectCommand`); add `StorageUnavailableException` (503 `STORAGE_UNAVAILABLE`) to `src/common/exceptions/domain.exception.ts` (existing convention: every domain exception lives there) and wrap every unexpected SDK/network error in it, leaving the tolerated `NoSuchUpload`/`NotFound` cases to the documented return values

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage-keys.spec.ts` | Unit | Allow-list mapping for the four content types; unknown content type rejected; key layout for originals and thumbnails |
| `src/storage/storage.service.spec.ts` | Unit | SDK errors wrapped as `StorageUnavailableException`; `NoSuchUpload` on abort and `NotFound` on head handled as documented (mocked clients) |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles with a global `ConfigModule`; both clients resolve with their distinct endpoints |
| `src/storage/storage.service.integration-spec.ts` | Integration | Real MinIO: create → presigned part PUT (via `fetch`) returns `ETag` → `listUploadedParts` → complete → `headObject` size; abort; presigned GET honors `Content-Disposition`; signed URL host equals the configured public endpoint (overridden to `http://minio:9000` inside the container) |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- A presigned `UploadPart` URL accepts an HTTP `PUT` of the part bytes directly against MinIO and returns `200` with an `ETag` header — no request reaches the API
- After uploading every part and completing the multipart upload, the object exists at `videos/{channelId}/{videoId}/original.{ext}` with a content length equal to the sum of the parts
- A presigned GET URL signed with an attachment disposition returns the object with a `Content-Disposition: attachment` header and serves `206 Partial Content` for a `Range` request
- Every presigned URL is addressed to the host of `STORAGE_PUBLIC_ENDPOINT` and stops working after `STORAGE_PRESIGN_EXPIRY_SECONDS`
- Aborting an already-aborted or unknown multipart upload completes without error
- With MinIO stopped, any storage operation fails with `STORAGE_UNAVAILABLE` (503) instead of an unhandled SDK error

---

### SI-03.6 — QueueModule: RabbitMQ Topology and Video-Processing Producer

**Description:** Connect both processes to RabbitMQ through `@golevelup/nestjs-rabbitmq`, declare the TD-01 topology from one shared constants module at bootstrap, and expose the `VIDEO_PROCESSING_QUEUE` producer port that publishes persistent `{ videoId }` messages and TTL-delayed retries.

**Technical actions:**

- Create `src/queue/video-processing.topology.ts` — the single source of every name and argument: exchange `video.processing` (`direct`, durable); quorum queue `video.processing` bound with routing key `video.processing.requested` and arguments `x-queue-type: quorum`, `x-delivery-limit: QUEUE_DELIVERY_LIMIT`, `x-dead-letter-exchange: video.processing.dlx`, `x-consumer-timeout: QUEUE_CONSUMER_TIMEOUT_MS`; exchange `video.processing.dlx` (`fanout`, durable) bound to quorum queue `video.processing.dlq` (inspection only); quorum queue `video.processing.retry` (no consumer) with `x-message-ttl: QUEUE_RETRY_DELAY_MS`, `x-dead-letter-exchange: video.processing`, `x-dead-letter-routing-key: video.processing.requested`; expose a `buildVideoProcessingTopology(queueConfig)` returning golevelup `exchanges` and `queues` definitions
- Create `src/queue/queue.module.ts` with `RabbitMQModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory })` setting `uri: RABBITMQ_URL`, the topology's `exchanges` and `queues` (module-level declaration, so the API and the worker both assert the topology at bootstrap and the API never publishes into an exchange without a bound queue), `channels: { default: { prefetchCount: 1, default: true } }`, `defaultPublishOptions: { persistent: true }`, `defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK` (per TD-01: an error escaping a subscriber — including a body that is not valid JSON — is nacked **without** requeue and dead-lettered; golevelup's own default is `REQUEUE`, which would redeliver immediately in a loop until `x-delivery-limit`) and `connectionInitOptions: { wait: true, timeout: 10000 }` (Compose starts both processes only after `rabbitmq` is healthy; reconnection afterwards stays with `amqp-connection-manager`)
- Create the port `src/queue/video-processing.queue.ts` — `VIDEO_PROCESSING_QUEUE` injection token and `VideoProcessingQueue` interface with `requestProcessing(videoId, attempt = 1)` and `scheduleRetry(videoId, attempt)`
- Implement `src/queue/rabbitmq-video-processing.queue.ts` with `AmqpConnection.publish`: `requestProcessing` → exchange `video.processing`, routing key `video.processing.requested`; `scheduleRetry` → default exchange `''` with routing key `video.processing.retry`; payload `{ videoId }`, options `{ messageId: videoId, persistent: true, contentType: 'application/json', headers: { 'x-attempt': attempt } }`; bound every publish with a 5 s timeout constant (`amqp-connection-manager` buffers publishes while disconnected, so the timeout is what surfaces an outage) and map timeout or channel errors to `QueueUnavailableException` (503 `QUEUE_UNAVAILABLE`, added to `src/common/exceptions/domain.exception.ts`)
- Register `{ provide: VIDEO_PROCESSING_QUEUE, useClass: RabbitMqVideoProcessingQueue }` in `QueueModule` and export the token; document in the module that quorum-queue arguments are immutable — any process or test that declares them with different `QUEUE_*` values fails with `PRECONDITION_FAILED`, so tests must use the same values as the running broker

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/video-processing.topology.spec.ts` | Unit | Names, bindings and arguments built from config; retry queue dead-letters to `video.processing` with the requested routing key; DLX bound to DLQ |
| `src/queue/rabbitmq-video-processing.queue.spec.ts` | Unit | Publish exchange/routing key/options per method (`messageId`, `persistent`, `x-attempt`); a publish that never resolves rejects with `QueueUnavailableException` after the timeout (fake timers) |
| `src/queue/rabbitmq-video-processing.queue.integration-spec.ts` | Integration | `QueueModule` boots against the Compose broker (module compile test); declared queues expose the expected arguments (`checkQueue`); a `requestProcessing` copy arrives in a temporary exclusive queue bound to `video.processing` with the requested routing key; `scheduleRetry` increases `video.processing.retry` depth; a subscriber created with `AmqpConnection.createSubscriber` on a temporary queue (dead-lettering to its own temporary target) that throws has its message dead-lettered exactly once and never redelivered (module default `NACK`) |

**Dependencies:** SI-03.1, SI-03.2

**Acceptance criteria:**

- Starting the API with RabbitMQ healthy creates exchange `video.processing`, quorum queues `video.processing`, `video.processing.retry` and `video.processing.dlq`, and exchange `video.processing.dlx` — visible in the management UI with the configured `x-delivery-limit`, `x-consumer-timeout`, `x-message-ttl` and dead-letter arguments
- Restarting the API against an already-declared topology succeeds without `PRECONDITION_FAILED`
- Requesting processing for a video causes a persistent message `{ "videoId": "<uuid>" }` with `message_id = <videoId>` and header `x-attempt = 1` to be routed to queue `video.processing`
- Scheduling a retry places the message in `video.processing.retry`; after `QUEUE_RETRY_DELAY_MS` it is dead-lettered back to `video.processing` carrying the incremented `x-attempt` header
- With RabbitMQ unreachable, a publish fails within 5 seconds with `QUEUE_UNAVAILABLE` (503) instead of hanging the request
- A message whose subscriber throws an unhandled error, or whose body is not valid JSON, is dead-lettered once (to `video.processing.dlq` for the processing queue) and is not redelivered

---

### SI-03.7 — Channel Ownership Guard and `channel_id` in `GET /auth/me`

**Description:** Add the ownership query and guard that protect every `channels/:channelId/videos/...` route, and extend `GET /auth/me` with the caller's `channel_id` so clients can build owner routes without a separate channel lookup endpoint.

**Technical actions:**

- Add to `src/channels/channels.service.ts`: `findByUserId(userId)` and `assertOwnership(channelId, userId)` — loads the channel by id, throws `ChannelNotFoundException` (404 `CHANNEL_NOT_FOUND`) when absent and `ChannelAccessDeniedException` (403 `CHANNEL_ACCESS_DENIED`) when `channel.user_id !== userId`; add both exception classes to `src/common/exceptions/domain.exception.ts`
- Create `src/channels/guards/channel-owner.guard.ts` — `CanActivate` reading `request.params.channelId` and `request.user.sub` (populated by the global `JwtAuthGuard`); rejects a non-UUID `channelId` with `ChannelNotFoundException` using `isUUID` from `class-validator` (guards run before pipes, so an invalid UUID must never reach Postgres as a 500); otherwise delegates to `ChannelsService.assertOwnership` (per TD-06 ownership guard)
- Make `ChannelsModule` export the guard alongside `ChannelsService`; import `ChannelsModule` in `AuthModule`
- Change `AuthController.me` to return `{ sub, email, channel_id }` via `ChannelsService.findByUserId(user.sub)` (registration creates the channel atomically — Phase 02 SI — so `channel_id` is always present for confirmed users), and update its `@ApiResponse` schema with `channel_id` (`string`, `uuid`)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/channels/channels.service.spec.ts` | Unit | `assertOwnership` throws the right exception for missing vs foreign channel; resolves for the owner |
| `src/channels/channels.service.integration-spec.ts` | Integration | `findByUserId` and `assertOwnership` against real Postgres (extend existing file) |
| `src/channels/guards/channel-owner.guard.spec.ts` | Unit | Non-UUID param → `CHANNEL_NOT_FOUND`; delegates to service with `params.channelId` and `user.sub` |
| `test/auth.e2e-spec.ts` | E2E | `GET /auth/me` now includes the caller's `channel_id` (extend existing file) |

**Dependencies:** None

**Acceptance criteria:**

- `GET /auth/me` with a valid access token returns 200 with `{ sub, email, channel_id }` where `channel_id` is the id of the channel created at the user's registration
- A request to any `channels/:channelId/videos` route for a channel owned by another user returns 403 with `CHANNEL_ACCESS_DENIED`
- A request to any `channels/:channelId/videos` route with a well-formed UUID that matches no channel returns 404 with `CHANNEL_NOT_FOUND`
- A request to any `channels/:channelId/videos` route with a malformed `channelId` (e.g., `abc`) returns 404 with `CHANNEL_NOT_FOUND`, never 500
- A request to any `channels/:channelId/videos` route without an access token returns 401, before ownership is evaluated

---

### SI-03.8 — Start Upload: `POST /channels/:channelId/videos` (Draft + Multipart Init)

**Description:** Register the video as a `draft` the moment the upload starts, open the S3 multipart upload at a server-generated key, and return every presigned part URL in one response so a 10 GiB upload never touches the API or the 10/60 s throttler.

**Technical actions:**

- Create `src/videos/dto/create-video.dto.ts` — `title` (`@IsString`, trimmed, `@Length(1, 100)`), `original_filename` (`@IsString`, `@Length(1, 255)`, stored for display/download only), `content_type` (`@IsIn` over the `VIDEO_CONTENT_TYPES` keys), `size_bytes` (`@IsInt`, `@Min(1)`); and response DTOs `UploadSessionDto` (`upload_id`, `part_size_bytes`, `part_count`, `expires_at`, `parts: { part_number, url }[]`) and `CreatedVideoDto` (`id`, `title`, `status`, `created_at`, `upload`)
- Create `src/videos/video-uploads.service.ts` `start(channelId, dto)`: reject `size_bytes > STORAGE_MAX_UPLOAD_BYTES` with `UploadTooLargeException` (422 `UPLOAD_TOO_LARGE`) before any write; `VideoLifecycleService.createDraft`; `StorageService.createMultipartUpload(originalKey(...))`; `attachUploadId`; compute `part_count = ceil(size_bytes / STORAGE_PART_SIZE_BYTES)` and presign parts `1..part_count` in one batch (per TD-02)
- Compensate init failures: if `createMultipartUpload` or `attachUploadId` throws, call `failDraft(id, 'STORAGE_UNAVAILABLE', ...)` and rethrow `StorageUnavailableException` (503) — a `draft` without an `upload_id` must never remain; add `UploadTooLargeException`, plus `VideoNotFoundException` (404 `VIDEO_NOT_FOUND`) and `VideoInvalidStateException` (409 `VIDEO_INVALID_STATE`) used by every owner and public video route that follows, to `src/common/exceptions/domain.exception.ts`
- Create `src/videos/videos.controller.ts` — `@Controller('channels/:channelId/videos')`, `@ApiTags('videos')`, `@ApiBearerAuth('access-token')`, class-level `@UseGuards(ChannelOwnerGuard)`; `@Post()` returns 201 with `CreatedVideoDto` and sets `Location: /channels/:channelId/videos/:id`; document 400/401/403/404/422/503 with `ApiErrorEnvelope`
- Create `src/videos/videos.module.ts` importing `VideoPersistenceModule`, `ChannelsModule` and `StorageModule` (providing `VideoUploadsService`, controller `VideosController`) and import `VideosModule` in `AppModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-uploads.service.spec.ts` | Unit | Size cap rejects before any write; `part_count` for 1 byte, exact multiple, 10 GiB (160 parts); storage failure → `failDraft` + `StorageUnavailableException` |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with its imports and a global `ConfigModule` |
| `test/videos-upload.e2e-spec.ts` | E2E | `POST /channels/:channelId/videos` 201 + Location + part URLs, 400 validation, 422 `UPLOAD_TOO_LARGE`, ownership 403/404 |

**Dependencies:** SI-03.4, SI-03.5, SI-03.7

**Acceptance criteria:**

- `POST /channels/:channelId/videos` by the channel owner with `{ title, original_filename, content_type: "video/mp4", size_bytes }` returns 201 with `{ id, title, status: "draft", created_at, upload: { upload_id, part_size_bytes, part_count, expires_at, parts } }` and header `Location: /channels/:channelId/videos/:id`; a `videos` row exists with `status = draft` and a non-null `upload_id`
- With `size_bytes = 10737418240` and the default part size, the response has `part_count = 160` and 160 entries in `parts`, numbered 1..160, each with a URL
- Every part URL targets `/{videos bucket}/{channelId}/{id}/original.mp4` on the public storage host, regardless of `original_filename` (e.g., `../../evil.exe` does not influence the key)
- `content_type` outside `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`, an empty or 101-character `title`, or `size_bytes` of `0` returns 400 validation error and creates no row
- `size_bytes` greater than `STORAGE_MAX_UPLOAD_BYTES` returns 422 with `UPLOAD_TOO_LARGE` and creates no row
- With storage unavailable, the request returns 503 with `STORAGE_UNAVAILABLE` and the created row is left in `status = error` with an `error_code` — never in `draft`

---

### SI-03.9 — Resume and Abort: `GET …/uploads/parts`, `POST …/uploads/abort`

**Description:** Let an interrupted upload resume by re-signing only the parts storage does not have yet, and let the owner abandon a draft explicitly.

**Technical actions:**

- Add `VideoUploadsService.resume(channelId, videoId)`: `findOwned` (absent → 404 `VIDEO_NOT_FOUND`); status other than `draft` → 409 `VIDEO_INVALID_STATE`; `listUploadedParts`; return `uploaded_parts: { part_number, size }[]` and fresh presigned URLs for only the part numbers in `1..part_count` that are missing
- Handle a vanished multipart upload in `resume` (`NoSuchUpload` while the row is still `draft`, e.g. after MinIO's stale-upload expiry): `headObject` on the original key — object present → return no missing parts (the client proceeds to `complete`); object absent → `failDraft(UPLOAD_EXPIRED)` and 409 `VIDEO_INVALID_STATE`
- Add `VideoUploadsService.abort(channelId, videoId)`: `findOwned` → 404; conditional `failDraft(id, UPLOAD_ABORTED)` first (losing the race to a concurrent `complete` → 409 `VIDEO_INVALID_STATE`); only then `abortMultipartUpload` — a storage failure at this point is logged and not surfaced, since the row is already terminal and MinIO's stale-upload expiry reclaims the parts
- Add to `VideosController`: `@Get(':videoId/uploads/parts')` with `@Throttle({ default: { limit: 30, ttl: 60000 } })` returning 200 `UploadPartsDto` (`upload_id`, `part_size_bytes`, `part_count`, `expires_at`, `uploaded_parts`, `parts`), and `@Post(':videoId/uploads/abort')` with `@HttpCode(204)`; both take `@Param('videoId', ParseUUIDPipe)`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-uploads.service.spec.ts` | Unit | Missing-part computation; non-draft → 409; vanished upload with/without object; abort transitions before calling storage (extend) |
| `test/videos-upload.e2e-spec.ts` | E2E | Parts after a partial upload, throttle override, abort 204 then parts 409, foreign video 404 (extend) |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- After uploading parts 1 and 2 of a 3-part draft through their presigned URLs, `GET /channels/:channelId/videos/:videoId/uploads/parts` returns 200 with `uploaded_parts` listing parts 1 and 2 and `parts` containing a fresh URL for part 3 only
- `GET …/uploads/parts` for a video whose status is not `draft` returns 409 with `VIDEO_INVALID_STATE`
- `GET …/uploads/parts` accepts 30 requests per minute from the same client; the 31st within the window returns 429
- `POST /channels/:channelId/videos/:videoId/uploads/abort` on a draft returns 204 with no response body — the row moves to `status = error` with `error_code = UPLOAD_ABORTED` and the multipart upload no longer exists in storage
- `POST …/uploads/abort` on a video that is not `draft` returns 409 with `VIDEO_INVALID_STATE`
- Any `…/:videoId/...` owner route using the id of a video that belongs to a different channel, under the caller's own `channelId`, returns 404 with `VIDEO_NOT_FOUND` — no cross-channel access
- A malformed `videoId` (non-UUID) returns 400 validation error

---

### SI-03.10 — Complete Upload: `POST …/uploads/complete` (Idempotent, Enqueue-After-Commit)

**Description:** Finalize the multipart upload from server-side state only, verify the stored size, move the video to `processing` exactly once, and publish the processing message after the commit — idempotent under client retries and concurrent calls.

**Technical actions:**

- Add `VideoUploadsService.complete(channelId, videoId)`: `findOwned` → 404 `VIDEO_NOT_FOUND`; `processing` → re-publish via `VIDEO_PROCESSING_QUEUE.requestProcessing` and return (idempotent); `ready`/`error` → 409 `VIDEO_INVALID_STATE`
- For `draft`, pre-check with `listUploadedParts` (client ETags are never trusted, per TD-02): any part in `1..part_count` missing → 409 `UPLOAD_INCOMPLETE`; any non-last part whose size ≠ `part_size_bytes` or a sum of part sizes ≠ `size_bytes` → 422 `UPLOAD_SIZE_MISMATCH`; in both cases the row stays `draft` and the upload stays resumable; add `UploadIncompleteException` and `UploadSizeMismatchException` to `src/common/exceptions/domain.exception.ts`
- Call `completeMultipartUpload` with the listed parts, then `headObject`: `ContentLength ≠ size_bytes` → `deleteObject`, `failDraft(UPLOAD_SIZE_MISMATCH)` and 422 `UPLOAD_SIZE_MISMATCH`; crash recovery — `NoSuchUpload` from `listUploadedParts` while the row is `draft` → `headObject` on the key: matching size → continue to the transition, size mismatch → same delete + `error` + 422 path, no object → `failDraft(UPLOAD_EXPIRED)` + 409 `VIDEO_INVALID_STATE`
- Commit `startProcessing(id)` (conditional `draft → processing`); losing the race to a concurrent `complete` → re-read and treat as the `processing` branch; then publish `requestProcessing(id)` — a `QueueUnavailableException` surfaces as 503 `QUEUE_UNAVAILABLE` with the row left in `processing` (recovered by a client retry or the sweeper, per TD-01); import `QueueModule` in `VideosModule`
- Add `@Post(':videoId/uploads/complete')` with `@HttpCode(202)` returning `{ id, status: "processing" }` and `Location: /channels/:channelId/videos/:videoId` (the owner detail used for polling)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-uploads.service.spec.ts` | Unit | Every branch: missing parts, wrong part sizes, HeadObject mismatch cleanup, NoSuchUpload recovery, lost transition race, publish after commit, publish failure keeps `processing` (extend) |
| `test/videos-upload.e2e-spec.ts` | E2E | Full upload through presigned URLs → complete 202 → row `processing` + one message recorded; repeat complete 202; 409 `UPLOAD_INCOMPLETE`; 503 `QUEUE_UNAVAILABLE` then successful retry (extend; overrides `VIDEO_PROCESSING_QUEUE` with an in-memory recorder so the running worker cannot race the assertions, and uses `STORAGE_PART_SIZE_BYTES = 5 MiB`) |

**Dependencies:** SI-03.6, SI-03.8

**Acceptance criteria:**

- After all parts are uploaded through their presigned URLs, `POST /channels/:channelId/videos/:videoId/uploads/complete` returns 202 with `{ id, status: "processing" }` and `Location: /channels/:channelId/videos/:videoId`; the object exists at the original key with the declared size, the row is `processing`, and one `video.processing.requested` message carrying the `videoId` is published
- Calling `complete` again on the same video (now `processing`) returns 202 and re-publishes the message without changing the row
- Two concurrent `complete` calls on the same fully uploaded draft both return 202 and the row transitions to `processing` exactly once
- `complete` with at least one missing part returns 409 with `UPLOAD_INCOMPLETE`; the row stays `draft` and `GET …/uploads/parts` still lists the missing parts
- `complete` when the uploaded bytes do not add up to the declared `size_bytes` returns 422 with `UPLOAD_SIZE_MISMATCH`
- `complete` on a `ready` or `error` video returns 409 with `VIDEO_INVALID_STATE`
- With RabbitMQ unavailable, `complete` returns 503 with `QUEUE_UNAVAILABLE` and the row stays `processing`; once the broker is back, repeating `complete` returns 202 and publishes the message

---

### SI-03.11 — Owner Video Detail: `GET /channels/:channelId/videos/:videoId`

**Description:** Give the owner a pollable view of a video in any status, including the user-safe failure details, so clients can track `draft → processing → ready | error`.

**Technical actions:**

- Create `src/videos/dto/owner-video.dto.ts` exposing `id`, `channel_id`, `title`, `original_filename`, `content_type`, `size_bytes`, `status`, `duration_seconds`, `metadata`, `error_code`, `error_message`, `created_at`, `updated_at`, `processed_at` — never `upload_id`, `processing_started_at` or `processing_attempts`
- Add `@Get(':videoId')` to `VideosController` with `@Param('videoId', ParseUUIDPipe)` and `@Throttle({ default: { limit: 60, ttl: 60000 } })` (polled while processing, per TD-06); resolves via `VideoLifecycleService.findOwned(channelId, videoId)` → 404 `VIDEO_NOT_FOUND` when absent; document 200/401/403/404 in Swagger

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos-owner.e2e-spec.ts` | E2E | Detail for `draft`/`processing`/`error` rows (seeded), hidden internal fields, foreign video 404, throttle override |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `GET /channels/:channelId/videos/:videoId` by the owner returns 200 with the video in any status — e.g., a `draft` row returns `status: "draft"` with `duration_seconds` and `metadata` null
- For a video in `error`, the response includes `error_code` (e.g., `INVALID_MEDIA`) and a user-safe `error_message` that contains no file paths or tool output
- The response never contains `upload_id`, `processing_started_at` or `processing_attempts`
- The endpoint accepts 60 requests per minute from the same client; the 61st within the window returns 429
- `GET` with the id of a video from a different channel returns 404 with `VIDEO_NOT_FOUND`

---

### SI-03.12 — Media Toolkit: Hardened FFprobe/FFmpeg Invocation

**Description:** Wrap the OS-installed `ffprobe`/`ffmpeg` binaries in a small typed toolkit that extracts duration and curated metadata and renders a JPEG thumbnail, classifying failures as permanent (bad media) or transient (timeouts) for the worker.

**Technical actions:**

- Create `src/worker/media/run-process.ts` — `runProcess(command, args, { timeoutMs, signal })` over `node:child_process.spawn` with an argument array (`shell: false`, never interpolating paths into a command string), bounded stdout capture, stderr tail capture for logs only, `SIGKILL` on timeout or abort; rejects with typed `ProcessTimeoutError` / `ProcessExitError` (per TD-03)
- Create `src/worker/processing.errors.ts` — `PermanentProcessingError(code: 'INVALID_MEDIA' | 'UNSUPPORTED_CODEC')` and `TransientProcessingError`; these are worker-internal (not `DomainException`) and carry only the stable code, never stderr
- Create `src/worker/media/media-probe.service.ts` — `probe(filePath)` runs `ffprobe -v error -protocol_whitelist file -print_format json -show_format -show_streams -- <file>` (timeout constant 60 s); duration from `format.duration`, falling back to the first video stream's `duration`; returns the curated `metadata` `{ container, codec, width, height, fps, bitrate }` (fps parsed from `avg_frame_rate` `num/den`; never the raw JSON, whose tags may carry PII); non-zero exit, no video stream or a non-finite/≤ 0 duration → `INVALID_MEDIA`; `format_name` outside the allowed containers (`mov,mp4,m4a,3gp,3g2,mj2`, `matroska,webm`) → `UNSUPPORTED_CODEC`; timeout → `TransientProcessingError`
- Create `src/worker/media/thumbnail.service.ts` — `render(filePath, durationSeconds, outPath)` runs `ffmpeg -hide_banner -loglevel error -protocol_whitelist file -ss <offset> -i <file> -frames:v 1 -vf scale=640:-2 -q:v 3 -y <out>.jpg` (`-ss` before `-i` for fast seek; timeout constant 120 s); offset = 10 % of the duration, `0` for clips shorter than 1 s; if no frame is produced at the offset, retry once at `0`; a decode failure → `UNSUPPORTED_CODEC`; register both services in `src/worker/media/media.module.ts`
- Add fixtures `test/fixtures/videos/sample-2s.mp4` (≈2 s, 320×240 H.264, generated once with `ffmpeg -f lavfi -i testsrc=duration=2:size=320x240:rate=25 -pix_fmt yuv420p`) and `test/fixtures/videos/not-a-video.mp4` (random bytes) for the integration tests

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/media/run-process.spec.ts` | Unit | Exit-code, timeout and abort mapping using `node -e` child scripts |
| `src/worker/media/media-probe.service.spec.ts` | Unit | Parsing of ffprobe JSON samples: duration fallback, fps parsing, missing video stream → `INVALID_MEDIA`, unsupported container → `UNSUPPORTED_CODEC`, curated subset only |
| `src/worker/media/media-toolkit.integration-spec.ts` | Integration | Real `ffprobe`/`ffmpeg` in the container: fixture yields duration ≈ 2 s and 320×240 metadata; thumbnail is a 640-wide JPEG; random bytes → `INVALID_MEDIA` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Probing the 2-second fixture returns a duration between 1.9 and 2.1 seconds and metadata `{ container, codec: "h264", width: 320, height: 240, fps: 25, bitrate }` with no other keys
- Rendering a thumbnail for the fixture produces a JPEG file 640 pixels wide
- Probing a file of random bytes fails with the permanent code `INVALID_MEDIA`
- A media command that exceeds its timeout is killed and reported as a transient failure, leaving no child process running
- A source path containing shell metacharacters (e.g., `a;rm -rf x.mp4`) is passed as a single argument and never executed

---

### SI-03.13 — Worker Process: Standalone Nest Context, Scripts and Compose Service

**Description:** Bootstrap the dedicated worker as a Nest standalone application context with its own entrypoint and Compose service, sharing configuration, TypeORM, storage and queue modules with the API but never its HTTP surface.

**Technical actions:**

- Extract the inline TypeORM options from `src/app.module.ts` into `src/database/typeorm-options.factory.ts` (`typeOrmOptionsFactory(dbConfig)` returning the same `postgres` options with `autoLoadEntities: true`, `synchronize: false`) and use it from `AppModule` (no behavior change)
- Create `src/worker/worker.module.ts` — `ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig, storageConfig, queueConfig, workerConfig], validationSchema: envValidationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })` (the worker reads the same `.env` as the API), `TypeOrmModule.forRootAsync` with the shared factory, `VideoPersistenceModule`, `StorageModule`, `QueueModule`, `MediaModule`; never `AuthModule`, `ThrottlerModule` or any controller
- Create `src/worker/main.ts` — `NestFactory.createApplicationContext(WorkerModule)` (golevelup discovers `@RabbitSubscribe` handlers during application bootstrap; no HTTP listener), `app.enableShutdownHooks()` so `SIGTERM` runs the shutdown hooks, and a startup log line
- Add `tsconfig.worker.json` (extends `tsconfig.build.json`, `outDir: ./dist-worker`) and scripts `start:worker:dev` (`nest start --watch --path tsconfig.worker.json --entryFile worker/main`) and `start:worker:prod` (`node dist/worker/main`); the separate `outDir` keeps the worker's watch build (with `deleteOutDir`) from wiping the API's `dist` on the shared bind mount; add `/dist-worker` to `.gitignore`
- Add Compose service `worker` — same `build` and bind mount as `nestjs-api`, `command: npm run start:worker:dev`, `restart: unless-stopped`, named volume `worker-scratch` mounted at `WORKER_SCRATCH_DIR`, `stop_grace_period: 60s`, `deploy.resources.limits` (`cpus: "2"`, `memory: 2g`), healthcheck `pgrep -f worker/main`, `depends_on` `db` (healthy), `minio-init` (completed successfully), `rabbitmq` (healthy) (per TD-07)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/worker.module.integration-spec.ts` | Integration | `WorkerModule` compiles and initializes against the Compose Postgres, MinIO and RabbitMQ; exposes the lifecycle, storage and queue providers; resolves no controller |

**Dependencies:** SI-03.3, SI-03.5, SI-03.6, SI-03.12

**Acceptance criteria:**

- `docker compose up -d` (after dependencies are installed with `docker compose exec nestjs-api npm install`) starts the `worker` service, which logs its startup and stays running without opening any HTTP port
- `docker compose stop worker` ends the process within the grace period with a clean shutdown log, not a `SIGKILL`
- Running `npm run start:dev` in `nestjs-api` and the worker in watch mode at the same time does not crash either process (separate build output directories)
- The API still boots and passes its existing E2E suites after the TypeORM options extraction

---

### SI-03.14 — Video Processing Consumer

**Description:** Consume `video.processing.requested` messages in the worker, claim the video, extract metadata and a thumbnail from the stored original, and drive the row to `ready` or `error` — idempotent under redelivery and resilient to transient failures.

**Technical actions:**

- Create `src/worker/video-processing.consumer.ts` with `@RabbitSubscribe({ queue: 'video.processing', queueOptions })` (queue name and options imported from the topology module — never redefined inline) and handler `handle(msg: { videoId }, amqpMsg: ConsumeMessage)`; a payload without a UUID `videoId` → return `new Nack(false)` (dead-lettered to `video.processing.dlq` for inspection); `claim(videoId, QUEUE_CONSUMER_TIMEOUT_MS)` → `null` means duplicate, stale or terminal → return (ack and drop)
- Implement the pipeline: scratch dir `{WORKER_SCRATCH_DIR}/{videoId}/`; `downloadToFile` of the original (key from `channel_id` + `content_type`); `MediaProbeService.probe`; `ThumbnailService.render`; `uploadFile` to `thumbnailKey(...)` (deterministic key — reprocessing overwrites); `markReady(id, { durationSeconds, metadata })`; remove the scratch dir in `finally`; return (ack) only after the row is terminal
- Route failures: `PermanentProcessingError` → `failProcessing(id, code, message)` and ack; any other error (storage, DB, timeouts) → if the claimed `processing_attempts < QUEUE_MAX_ATTEMPTS`, `releaseClaim(id)` then `scheduleRetry(id, processing_attempts + 1)` and ack, otherwise `failProcessing(id, PROCESSING_FAILED)` and ack; if scheduling the retry itself fails, return `new Nack(true)` (redelivery bounded by `x-delivery-limit`; the sweeper closes the row) (per TD-01 failure routing; the database counter is authoritative and the `x-attempt` header mirrors it); the handler body catches every error so routing is always explicit — an error that still escapes (e.g., `failProcessing` or `releaseClaim` failing inside the catch path) is nacked without requeue by the `QueueModule` default `defaultSubscribeErrorBehavior: NACK` (per TD-01), so the message lands in `video.processing.dlq` for inspection and the sweeper recovers the row (SI-03.15 rules 2 and 3)
- Handle shutdown in `beforeApplicationShutdown`: abort the in-flight job through an `AbortSignal` passed to the download and child processes, `releaseClaim` the video and return `new Nack(true)` so the message is redelivered to another worker immediately (if the channel is already closing, the unacked message is redelivered anyway)
- Register the consumer in `WorkerModule`; log `videoId`, attempt, outcome and elapsed time per job, keeping stderr in logs only

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video-processing.consumer.spec.ts` | Unit | Branches with mocked ports: invalid payload → `Nack(false)`; unclaimed → ack; success → `markReady`; permanent → `error`; transient below/at max attempts; retry publish failure → `Nack(true)`; scratch cleanup in all paths |
| `src/worker/video-processing.consumer.integration-spec.ts` | Integration | Handler called directly with `{ videoId }` against real Postgres, MinIO and FFmpeg: fixture original → `ready` with duration, metadata and thumbnail object; random bytes → `error/INVALID_MEDIA`; second call after `ready` is a no-op |

**Dependencies:** SI-03.4, SI-03.12, SI-03.13

**Acceptance criteria:**

- Completing the upload of a valid MP4 causes the video to reach `status = ready` with `duration_seconds`, curated `metadata` and `processed_at` set, and a JPEG thumbnail stored at `thumbnails/{channelId}/{videoId}/thumbnail.jpg`
- Completing the upload of a file that is not decodable video causes the video to reach `status = error` with `error_code = INVALID_MEDIA` and a user-safe `error_message`
- Delivering the same `video.processing.requested` message twice for a video already `ready` leaves the row and the thumbnail unchanged and both messages are acknowledged
- A transient storage failure during processing causes the message to be re-published to `video.processing.retry` and processed again after `QUEUE_RETRY_DELAY_MS`; after `QUEUE_MAX_ATTEMPTS` failed attempts the video ends in `status = error` with `error_code = PROCESSING_FAILED`
- After any job, no files remain under `WORKER_SCRATCH_DIR/{videoId}/`
- Stopping the worker mid-job leaves the video `processing` with its claim released, and the job is picked up again when a worker is running
- While the worker is running, the management UI shows one consumer on queue `video.processing` with prefetch 1

---

### SI-03.15 — Recovery Sweeper in the Worker

**Description:** Run a periodic task inside the worker that closes the gaps at-least-once delivery cannot: expired drafts, `processing` rows whose message was lost after commit, and jobs stuck past the lease.

**Technical actions:**

- Create `src/worker/video-sweeper.service.ts` — start a native `setInterval` in `onApplicationBootstrap` (interval constant `SWEEP_INTERVAL_MS = 300000`, plus one run at startup) and clear it in `beforeApplicationShutdown`; skip a tick while the previous run is still in progress (no new library, per resolved validation)
- Rule 1 — stale drafts: for each row from `findStaleDrafts(VIDEO_DRAFT_TTL_HOURS)`, `failDraft(id, UPLOAD_EXPIRED)` (conditional; skip on a lost race) and then `abortMultipartUpload` (`NoSuchUpload` tolerated; a storage failure is logged — MinIO's stale-upload expiry is the backstop)
- Rule 2 — never-claimed `processing` rows: for each row from `findUnclaimedProcessing(UNCLAIMED_GRACE_MS = 600000)`, `requestProcessing(id)` and `touch(id)` so the same row is not re-published before another grace window
- Rule 3 — expired leases: for each row from `findExpiredLeases(QUEUE_CONSUMER_TIMEOUT_MS)`, re-publish while `processing_attempts < QUEUE_MAX_ATTEMPTS`, otherwise `timeoutProcessing(id)` (`error/PROCESSING_TIMEOUT`, guarded so a fresh claim is never overridden)
- Isolate each row in its own try/catch with structured logs (rule, `videoId`, outcome); a `QueueUnavailableException` stops the remaining publishes for that run; register the service in `WorkerModule` — concurrent sweepers from multiple worker replicas are safe because every write is conditional and duplicate messages are dropped by the claim

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video-sweeper.service.spec.ts` | Unit | Each rule's decision with mocked ports; per-row error isolation; queue outage stops publishes; overlapping ticks skipped; interval cleared on shutdown (fake timers) |
| `src/worker/video-sweeper.service.integration-spec.ts` | Integration | `sweep()` called directly against real Postgres and MinIO with backdated rows: stale draft → `error/UPLOAD_EXPIRED` and its multipart upload aborted; unclaimed row re-published once per grace window; expired lease re-published or timed out by attempt count (queue port recorded) |

**Dependencies:** SI-03.4, SI-03.13

**Acceptance criteria:**

- A `draft` older than `VIDEO_DRAFT_TTL_HOURS` is moved to `status = error` with `error_code = UPLOAD_EXPIRED` within one sweep interval, and its multipart upload no longer exists in storage
- A `processing` video that was never claimed for more than 10 minutes (e.g., the publish was lost after the commit) causes a new `video.processing.requested` message for that video within one sweep interval, and the video then reaches `ready` or `error`
- A `processing` video claimed longer than `QUEUE_CONSUMER_TIMEOUT_MS` with attempts remaining causes a new `video.processing.requested` message; with `processing_attempts` already at `QUEUE_MAX_ATTEMPTS` it is moved to `status = error` with `error_code = PROCESSING_TIMEOUT`
- `draft`, `processing` rows within their windows and `ready` rows are left unchanged by a sweep
- With RabbitMQ unavailable during a sweep, the worker keeps running and the affected rows are retried on the next sweep

---

### SI-03.16 — Public Video Endpoints: Metadata, Stream, Download, Thumbnail

**Description:** Expose ready videos at their unique UUID URL without authentication, handing out short-lived presigned GET URLs so storage serves the bytes (including `Range`/`206`) directly.

**Technical actions:**

- Create `src/videos/public-videos.service.ts` — resolves `VideoLifecycleService.findReady(id)` (any other status or unknown id → 404 `VIDEO_NOT_FOUND`, no existence leak, per TD-05) and builds: metadata; stream URL (`presignGetObject` on the original key); download URL (`presignGetObject` with `ResponseContentDisposition`); thumbnail URL (`presignGetObject` on `thumbnailKey`)
- Create `src/videos/content-disposition.util.ts` — `attachmentDisposition(originalFilename)` returning `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987 percent-encoded>`; strips path separators, control characters and quotes, caps the length, and falls back to `video.<ext>` when nothing usable remains
- Create `src/videos/public-videos.controller.ts` — `@Controller('videos')`, `@ApiTags('videos')`, every route `@Public()` with no `@ApiBearerAuth`, class-level `@Throttle({ default: { limit: 120, ttl: 60000 } })`, `@Param('id', ParseUUIDPipe)`: `GET :id` → 200 `PublicVideoDto` (`id`, `channel_id`, `title`, `content_type`, `size_bytes`, `duration_seconds`, `metadata`, `created_at`, `processed_at`); `GET :id/stream`, `GET :id/download`, `GET :id/thumbnail` → 200 `PresignedUrlDto` (`url`, `expires_at`)
- Register the controller and service in `VideosModule` (owner and public behavior never share a route, per TD-06)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/content-disposition.util.spec.ts` | Unit | ASCII fallback, RFC 5987 encoding of non-ASCII names, removal of `/`, `\`, quotes and control characters, empty-name fallback |
| `test/videos-public.e2e-spec.ts` | E2E | Seeded `ready` video + objects: metadata 200 without token; stream URL serves `206` for a `Range` request; download URL returns `Content-Disposition: attachment`; thumbnail URL returns `image/jpeg`; non-ready/unknown 404; malformed id 400; throttle override |

**Dependencies:** SI-03.5, SI-03.8

**Acceptance criteria:**

- `GET /videos/:id` without an `Authorization` header for a `ready` video returns 200 with `{ id, channel_id, title, content_type, size_bytes, duration_seconds, metadata, created_at, processed_at }` and no `error_*`, `upload_id` or processing fields
- `GET /videos/:id/stream` for a `ready` video returns 200 with `{ url, expires_at }`; a request to `url` with `Range: bytes=0-1023` returns 206 with exactly 1024 bytes
- `GET /videos/:id/download` returns 200 with `{ url, expires_at }`; fetching `url` returns a `Content-Disposition: attachment` header whose filename is the sanitized `original_filename` (e.g., `Férias 2024.mp4` → `filename*=UTF-8''F%C3%A9rias%202024.mp4`)
- `GET /videos/:id/thumbnail` returns 200 with `{ url, expires_at }` and `url` serves a JPEG image
- `GET /videos/:id` (and each sub-route) for a video in `draft`, `processing` or `error`, or for an unknown UUID, returns 404 with `VIDEO_NOT_FOUND` — the same response in every case
- `expires_at` equals the signing time plus `STORAGE_PRESIGN_EXPIRY_SECONDS`; the public routes accept 120 requests per minute per client, the 121st returns 429

---

### SI-03.17 — OpenAPI Export, Copilot Instructions and Run Documentation

**Description:** Regenerate the versioned OpenAPI document for the new video routes and update the repository instructions so humans and agents can run and extend the upload/processing pipeline.

**Technical actions:**

- Run `npm run openapi:export` to regenerate `nestjs-project/openapi.json` with the `videos` tag, all owner and public video routes, the extended `GET /auth/me` schema, and no security requirement on `/videos/{id}*`
- Add a "Videos" section to `.github/copilot-instructions.md` and `nestjs-project/AGENTS.md`: upload protocol (create → PUT parts → parts/resume → complete/abort), status lifecycle and who writes each transition, `VideoLifecycleService` as the only status writer, queue topology constants module, storage key layout and buckets, worker entrypoint and sweeper, error codes, and test conventions (real MinIO/RabbitMQ/FFmpeg in integration, `VIDEO_PROCESSING_QUEUE` override in E2E, immutable quorum-queue arguments)
- Update `nestjs-project/README.md` with the new Compose services (MinIO console `:9001`, RabbitMQ management `:15672`, `worker`), the first-run order (`docker compose up -d` → `docker compose exec nestjs-api npm install` → `migration:run` → `docker compose restart worker`), and the browser-reachable storage endpoint note; mark the Video Worker, Object Storage and Message Queue components as implemented in the root `README.md` architecture list

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/openapi-export.integration-spec.ts` | Integration | Exported document contains every Phase 03 path and the `videos` tag; public video paths have no security requirement; owner paths require `access-token` (extend existing file) |

**Dependencies:** SI-03.9, SI-03.10, SI-03.11, SI-03.14, SI-03.15, SI-03.16

**Acceptance criteria:**

- `npm run openapi:export` produces an `openapi.json` that lists `POST /channels/{channelId}/videos`, `GET /channels/{channelId}/videos/{videoId}`, the three `…/uploads/*` routes and the four `/videos/{id}*` routes, each with its documented success and error responses
- Swagger UI at `/api/docs` shows the `videos` tag; the public routes can be executed without authorizing
- A developer following only `nestjs-project/README.md` can bring up the stack, run migrations, complete an upload and see the video reach `ready`

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated (`uuid_generate_v4()`) | Public URL identifier (TD-04); also the `{videoId}` storage key segment |
| channel_id | uuid | FK → channels.id `ON DELETE NO ACTION`, not null | Owning channel; every owner query filters by it |
| title | varchar(100) | not null | Trimmed, 1–100 characters |
| original_filename | varchar(255) | not null | Display and download name only — never part of a storage key |
| content_type | varchar(100) | not null | One of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`; determines the key extension |
| size_bytes | bigint | not null | Declared at creation, verified at completion; mapped to `number` by a column transformer |
| status | enum `videos_status_enum` | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'error'` | Written only through `VideoLifecycleService` conditional updates |
| upload_id | varchar | nullable | S3 multipart `UploadId`; set right after creation |
| duration_seconds | numeric(10,3) | nullable | Set on `ready`; mapped to `number` |
| metadata | jsonb | nullable | Curated `{ container, codec, width, height, fps, bitrate }` — never raw ffprobe output |
| error_code | varchar(50) | nullable | Stable code: `INVALID_MEDIA`, `UNSUPPORTED_CODEC`, `PROCESSING_FAILED`, `PROCESSING_TIMEOUT`, `UPLOAD_EXPIRED`, `UPLOAD_ABORTED`, `UPLOAD_SIZE_MISMATCH`, `STORAGE_UNAVAILABLE` |
| error_message | varchar(255) | nullable | Fixed user-safe text per `error_code` |
| processing_started_at | timestamp | nullable | Worker lease start; `NULL` = not claimed |
| processing_attempts | int | not null, default `0` | Incremented by each claim; reset on `draft → processing` |
| processed_at | timestamp | nullable | Set on `ready` |
| created_at | timestamp | not null, auto-generated | |
| updated_at | timestamp | not null, auto-generated | Set explicitly by every transition; used by the sweeper's unclaimed grace window |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`); Channel → Video (one-to-many, inverse side `videos`)
**Indexes:** `(channel_id)` — FK, `(status, created_at)` — sweeper scans

**Derived storage keys (not stored):**

| Object | Bucket | Key |
|--------|--------|-----|
| Original | `STORAGE_BUCKET_VIDEOS` (`videos`) | `{channelId}/{videoId}/original.{mp4\|mov\|webm\|mkv}` |
| Thumbnail | `STORAGE_BUCKET_THUMBNAILS` (`thumbnails`) | `{channelId}/{videoId}/thumbnail.jpg` |

---

### API Contracts

All `channels/:channelId/videos` routes require `Authorization: Bearer <access_token>` and additionally return:
- 401: missing or invalid access token (Phase 02 guard)
- 404 CHANNEL_NOT_FOUND: `channelId` is malformed or matches no channel
- 403 CHANNEL_ACCESS_DENIED: the channel belongs to another user
- 400 validation error: `videoId` is not a UUID (routes with `:videoId`)
- 404 VIDEO_NOT_FOUND: `videoId` does not exist within `channelId` (routes with `:videoId`)

#### GET /auth/me (SI-03.7 — modified)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- sub: string (uuid)
- email: string
- channel_id: string (uuid) — **new**

---

#### POST /channels/:channelId/videos (SI-03.8)

**Request headers:**
- Authorization: Bearer <access_token>
- Content-Type: application/json

**Request body:**
- title: string, required — trimmed, 1–100 characters
- original_filename: string, required — 1–255 characters
- content_type: string, required — one of `video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`
- size_bytes: integer, required — ≥ 1

**Response 201:**
- id: string (uuid)
- title: string
- status: `"draft"`
- created_at: string (ISO 8601)
- upload: object
  - upload_id: string
  - part_size_bytes: integer
  - part_count: integer — `ceil(size_bytes / part_size_bytes)`
  - expires_at: string (ISO 8601) — part URL expiry
  - parts: array of `{ part_number: integer, url: string }` — numbered `1..part_count`

**Response headers:**
- Location: /channels/:channelId/videos/:id

**Error responses:**
- 422 UPLOAD_TOO_LARGE: `size_bytes` exceeds `STORAGE_MAX_UPLOAD_BYTES`
- 503 STORAGE_UNAVAILABLE: storage failed while opening the multipart upload (the row is moved to `error`)
- 400 validation error: body fails schema validation (including a `content_type` outside the allow-list)

**Client protocol:** split the file into `part_size_bytes` chunks (last chunk may be smaller), `PUT` chunk *n* to `parts[n-1].url` directly against storage (the response `ETag` header needs no client bookkeeping), then call `complete`.

---

#### GET /channels/:channelId/videos/:videoId/uploads/parts (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- upload_id: string
- part_size_bytes: integer
- part_count: integer
- expires_at: string (ISO 8601)
- uploaded_parts: array of `{ part_number: integer, size: integer }`
- parts: array of `{ part_number: integer, url: string }` — only the missing parts, freshly signed

**Error responses:**
- 409 VIDEO_INVALID_STATE: the video is not `draft`, or its multipart upload expired with no stored object (the row moves to `error/UPLOAD_EXPIRED`)
- 429: more than 30 requests per 60 s from the client

---

#### POST /channels/:channelId/videos/:videoId/uploads/complete (SI-03.10)

**Request headers:**
- Authorization: Bearer <access_token>

**Request body:** none

**Response 202:**
- id: string (uuid)
- status: `"processing"`

**Response headers:**
- Location: /channels/:channelId/videos/:videoId — poll for the final status

**Error responses:**
- 409 UPLOAD_INCOMPLETE: at least one part in `1..part_count` is missing (row stays `draft`)
- 422 UPLOAD_SIZE_MISMATCH: uploaded part sizes do not match `part_size_bytes`/`size_bytes` (row stays `draft`), or the completed object's length differs from `size_bytes` (object deleted, row moves to `error/UPLOAD_SIZE_MISMATCH`)
- 409 VIDEO_INVALID_STATE: the video is `ready` or `error`
- 503 STORAGE_UNAVAILABLE: storage failed during listing, completion or verification (row stays `draft`; retry is safe)
- 503 QUEUE_UNAVAILABLE: the processing message could not be published (row stays `processing`; retry is safe)

---

#### POST /channels/:channelId/videos/:videoId/uploads/abort (SI-03.9)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 204:** no body — the row moves to `error/UPLOAD_ABORTED` and the multipart upload is aborted

**Error responses:**
- 409 VIDEO_INVALID_STATE: the video is not `draft`

---

#### GET /channels/:channelId/videos/:videoId (SI-03.11)

**Request headers:**
- Authorization: Bearer <access_token>

**Response 200:**
- id: string (uuid)
- channel_id: string (uuid)
- title: string
- original_filename: string
- content_type: string
- size_bytes: integer
- status: `"draft"` | `"processing"` | `"ready"` | `"error"`
- duration_seconds: number | null
- metadata: `{ container: string, codec: string, width: integer, height: integer, fps: number, bitrate: integer }` | null
- error_code: string | null
- error_message: string | null
- created_at: string (ISO 8601)
- updated_at: string (ISO 8601)
- processed_at: string (ISO 8601) | null

**Error responses:**
- 429: more than 60 requests per 60 s from the client

---

#### GET /videos/:id (SI-03.16)

**Request headers:** none (public)

**Response 200:**
- id: string (uuid)
- channel_id: string (uuid)
- title: string
- content_type: string
- size_bytes: integer
- duration_seconds: number
- metadata: `{ container, codec, width, height, fps, bitrate }`
- created_at: string (ISO 8601)
- processed_at: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id or `status ≠ ready` (identical response)
- 400 validation error: `id` is not a UUID
- 429: more than 120 requests per 60 s from the client

---

#### GET /videos/:id/stream · GET /videos/:id/download · GET /videos/:id/thumbnail (SI-03.16)

**Request headers:** none (public)

**Response 200:**
- url: string — presigned GET on `STORAGE_PUBLIC_ENDPOINT`
  - `stream`: the original; storage answers `Range` requests with `206 Partial Content`
  - `download`: the original, signed with `ResponseContentDisposition: attachment; filename="<ASCII>"; filename*=UTF-8''<RFC 5987>` from the sanitized `original_filename`
  - `thumbnail`: the JPEG thumbnail
- expires_at: string (ISO 8601) — signing time + `STORAGE_PRESIGN_EXPIRY_SECONDS`; clients re-request after a storage `403`

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id or `status ≠ ready`
- 400 validation error: `id` is not a UUID
- 429: more than 120 requests per 60 s from the client

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner | Notes |
|----------|-----------|---------------|-------|-------|
| GET /auth/me | ✗ | ✓ | ✓ | Now includes `channel_id` |
| POST /channels/:channelId/videos | ✗ | ✗ | ✓ | `ChannelOwnerGuard`; global 10/60 s throttle |
| GET /channels/:channelId/videos/:videoId/uploads/parts | ✗ | ✗ | ✓ | `ChannelOwnerGuard`; `@Throttle` 30/60 s |
| POST /channels/:channelId/videos/:videoId/uploads/complete | ✗ | ✗ | ✓ | `ChannelOwnerGuard`; global 10/60 s throttle |
| POST /channels/:channelId/videos/:videoId/uploads/abort | ✗ | ✗ | ✓ | `ChannelOwnerGuard`; global 10/60 s throttle |
| GET /channels/:channelId/videos/:videoId | ✗ | ✗ | ✓ | `ChannelOwnerGuard`; any status; `@Throttle` 60/60 s |
| GET /videos/:id | ✓ | ✓ | ✓ | `@Public()`; `ready` only; `@Throttle` 120/60 s |
| GET /videos/:id/stream | ✓ | ✓ | ✓ | `@Public()`; `ready` only; `@Throttle` 120/60 s |
| GET /videos/:id/download | ✓ | ✓ | ✓ | `@Public()`; `ready` only; `@Throttle` 120/60 s |
| GET /videos/:id/thumbnail | ✓ | ✓ | ✓ | `@Public()`; `ready` only; `@Throttle` 120/60 s |

Owner = authenticated user whose channel matches `:channelId` (one channel per user). A non-owner authenticated caller receives `403 CHANNEL_ACCESS_DENIED`; an anonymous caller receives `401`.

Presigned storage URLs carry their own time-limited authorization (`STORAGE_PRESIGN_EXPIRY_SECONDS`); the storage buckets are never publicly readable.

---

### Error Catalog

Inherits the `{ statusCode, error, message }` format from Phase 02 (per `phase-02-auth/TD-07`).

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found | Any `channels/:channelId/videos` route when `channelId` is malformed or matches no channel |
| CHANNEL_ACCESS_DENIED | 403 | You do not have access to this channel | Any `channels/:channelId/videos` route when the channel belongs to another user |
| VIDEO_NOT_FOUND | 404 | Video not found | Owner routes: `videoId` does not exist within `channelId`. Public routes: unknown id or `status ≠ ready` (same response for both) |
| VIDEO_INVALID_STATE | 409 | Video is not in a valid state for this operation | `uploads/parts` or `uploads/abort` on a non-`draft` video; `uploads/complete` on a `ready`/`error` video; `parts`/`complete` when the multipart upload expired with no stored object |
| UPLOAD_TOO_LARGE | 422 | File exceeds the maximum upload size | POST /channels/:channelId/videos with `size_bytes > STORAGE_MAX_UPLOAD_BYTES` |
| UPLOAD_INCOMPLETE | 409 | Upload is missing parts | POST …/uploads/complete when any part in `1..part_count` is absent from storage |
| UPLOAD_SIZE_MISMATCH | 422 | Uploaded size does not match the declared size | POST …/uploads/complete when part sizes or their sum differ from the declared layout, or the completed object's length ≠ `size_bytes` |
| STORAGE_UNAVAILABLE | 503 | Storage service is temporarily unavailable | POST /channels/:channelId/videos when opening the multipart upload fails; `uploads/parts` or `uploads/complete` when a storage call fails |
| QUEUE_UNAVAILABLE | 503 | Processing queue is temporarily unavailable | POST …/uploads/complete when publishing the processing message fails or times out (5 s) |

**Video failure codes** (persisted in `videos.error_code` and shown to the owner via the owner detail route — not HTTP errors):

| Code | Message (`error_message`) | Set by |
|------|---------------------------|--------|
| INVALID_MEDIA | The file is not a valid video | Worker — ffprobe fails, no video stream, or invalid duration |
| UNSUPPORTED_CODEC | The video format or codec is not supported | Worker — container outside the allowed set or frame decode failure |
| PROCESSING_FAILED | Video processing failed, please upload again | Worker — transient failure after `QUEUE_MAX_ATTEMPTS` attempts |
| PROCESSING_TIMEOUT | Video processing took too long and was stopped | Sweeper — lease expired with no attempts left |
| UPLOAD_EXPIRED | The upload was not completed in time | Sweeper — draft older than `VIDEO_DRAFT_TTL_HOURS`; API — multipart upload vanished with no object |
| UPLOAD_ABORTED | The upload was cancelled | API — POST …/uploads/abort |
| UPLOAD_SIZE_MISMATCH | The uploaded file size does not match the declared size | API — completed object length ≠ `size_bytes` |
| STORAGE_UNAVAILABLE | The upload could not be started | API — storage failure while opening the multipart upload |

---

### Events/Messages

#### video.processing.requested

**Payload:**

```json
{ "videoId": "uuid" }
```

Message properties: `messageId = videoId`, `persistent: true`, `contentType: application/json`, header `x-attempt: integer` (mirrors `processing_attempts`; the database counter is authoritative).

**Producer:** `VideoUploadsService` on `POST …/uploads/complete`; `VideoSweeperService` for unclaimed rows and expired leases (per `phase-03-videos/TD-01`, `phase-03-videos/TD-06`)
**Consumer:** `VideoProcessingConsumer` in the worker process, `prefetchCount: 1` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`)
**Trigger:** After the `draft → processing` transaction commits (enqueue-after-commit); re-published by the sweeper when a `processing` row is never claimed within `UNCLAIMED_GRACE_MS` or its lease expires with attempts left
**Delivery semantics:** at-least-once — ack only after the row is terminal or the retry is scheduled; duplicates are absorbed by the lease claim (per `phase-03-videos/TD-01`)

#### video.processing.requested (delayed retry)

**Payload:**

```json
{ "videoId": "uuid" }
```

Header `x-attempt = processing_attempts + 1`.

**Producer:** `VideoProcessingConsumer` via `scheduleRetry` → queue `video.processing.retry` through the default exchange (per `phase-03-videos/TD-01`)
**Consumer:** `VideoProcessingConsumer` — the message is dead-lettered back to exchange `video.processing` after `QUEUE_RETRY_DELAY_MS` (per `phase-03-videos/TD-01`)
**Trigger:** Transient processing failure while `processing_attempts < QUEUE_MAX_ATTEMPTS`
**Delivery semantics:** at-least-once (per `phase-03-videos/TD-01`)

#### Dead letter (video.processing.dlq)

**Payload:** the original message, unchanged

**Producer:** Broker — `x-delivery-limit` exceeded; the consumer returns `Nack(false)` for an invalid payload; or an error escapes the handler / the body is not valid JSON (`defaultSubscribeErrorBehavior: NACK`) (per `phase-03-videos/TD-01`)
**Consumer:** None — `video.processing.dlq` is for inspection only; `VideoSweeperService` closes the affected row (per `phase-03-videos/TD-06`)
**Trigger:** Poison or repeatedly redelivered message
**Delivery semantics:** best-effort (inspection only)

**Topology** (declared by both API and worker from `src/queue/video-processing.topology.ts`):

| Name | Kind | Arguments / binding |
|------|------|---------------------|
| video.processing | exchange (direct, durable) | — |
| video.processing | quorum queue | bound with `video.processing.requested`; `x-delivery-limit: QUEUE_DELIVERY_LIMIT`, `x-dead-letter-exchange: video.processing.dlx`, `x-consumer-timeout: QUEUE_CONSUMER_TIMEOUT_MS` |
| video.processing.retry | quorum queue (no consumer) | `x-message-ttl: QUEUE_RETRY_DELAY_MS`, `x-dead-letter-exchange: video.processing`, `x-dead-letter-routing-key: video.processing.requested` |
| video.processing.dlx | exchange (fanout, durable) | — |
| video.processing.dlq | quorum queue | bound to `video.processing.dlx` |

---

## Dependency Map

```
SI-03.1 (no deps)
└── SI-03.2
    ├── SI-03.5   (also SI-03.1)
    ├── SI-03.6   (also SI-03.1)
    └── SI-03.12

SI-03.3 (no deps)
└── SI-03.4

SI-03.7 (no deps)

SI-03.4 + SI-03.5 + SI-03.7
└── SI-03.8
    ├── SI-03.9
    └── SI-03.11

SI-03.6 + SI-03.8
└── SI-03.10

SI-03.5 + SI-03.8
└── SI-03.16

SI-03.3 + SI-03.5 + SI-03.6 + SI-03.12
└── SI-03.13

SI-03.4 + SI-03.12 + SI-03.13
└── SI-03.14

SI-03.4 + SI-03.13
└── SI-03.15

SI-03.9 + SI-03.10 + SI-03.11 + SI-03.14 + SI-03.15 + SI-03.16
└── SI-03.17
```

Linearized implementation order: SI-03.1, SI-03.3, SI-03.7 (parallel) → SI-03.2, SI-03.4 (parallel) → SI-03.5, SI-03.6, SI-03.12 (parallel) → SI-03.8, SI-03.13 (parallel) → SI-03.9, SI-03.10, SI-03.11, SI-03.16, SI-03.14, SI-03.15 (parallel) → SI-03.17

## Deliverables

- [ ] MinIO (S3-compatible, `pgsty/minio`), bucket init (`videos`, `thumbnails`, private, CORS exposing `ETag`) and RabbitMQ 4.3 (management UI) in Docker Compose, with persistent volumes for Postgres, MinIO and RabbitMQ
- [ ] `ffmpeg`/`ffprobe` available in the dev image; `worker` Compose service running the standalone worker process with CPU/memory limits and a 60 s stop grace period
- [ ] `videos` table with `videos_status_enum` (`draft | processing | ready | error`) created by a reversible migration; FK to `channels` with `ON DELETE NO ACTION`
- [ ] All status writes go through `VideoLifecycleService` conditional updates; concurrent workers cannot both claim the same video
- [ ] Owner-only access to `channels/:channelId/videos` routes via `ChannelOwnerGuard` (`CHANNEL_NOT_FOUND`, `CHANNEL_ACCESS_DENIED`); `GET /auth/me` returns `channel_id`
- [ ] Direct-to-storage multipart upload: create draft + presigned part URLs (201 + `Location`), resume (`uploads/parts`), abort (204) and idempotent complete (202 + `Location`) with size verification
- [ ] Uploads above `STORAGE_MAX_UPLOAD_BYTES` (10 GiB) rejected with 422 `UPLOAD_TOO_LARGE`; content types restricted to MP4, MOV, WebM, MKV
- [ ] `video.processing.requested` published only after the `draft → processing` commit; publish failures return 503 `QUEUE_UNAVAILABLE` and the sweeper recovers the row
- [ ] Worker validates media with ffprobe (no shell, timeouts, container allow-list), extracts duration + curated metadata, generates a JPEG thumbnail and marks the video `ready`, or `error` with a stable `error_code`
- [ ] Transient worker failures retried through the delayed retry queue up to `QUEUE_MAX_ATTEMPTS`; malformed messages, unhandled handler errors (`defaultSubscribeErrorBehavior: NACK`, never requeued) and delivery-limit overflow land in `video.processing.dlq`
- [ ] Recovery sweeper expires stale drafts (`UPLOAD_EXPIRED`), re-publishes unclaimed `processing` rows and recovers or times out (`PROCESSING_TIMEOUT`) expired leases
- [ ] Graceful worker shutdown: in-flight ffmpeg aborted, claim released, message requeued
- [ ] Owner video detail exposes status, metadata and error information without leaking `upload_id` or internal processing fields
- [ ] Public metadata, stream (HTTP Range via presigned URL), download (`Content-Disposition: attachment` with sanitized filename) and thumbnail endpoints serve only `ready` videos; all other states return 404 `VIDEO_NOT_FOUND`
- [ ] Per-route throttling: `uploads/parts` 30/60 s, owner detail 60/60 s, public video routes 120/60 s
- [ ] `openapi.json` regenerated (`npm run openapi:export`) and includes all Phase 03 routes with their success and error responses
- [ ] `.env.example`, `nestjs-project/README.md`, root `README.md` and `.github/copilot-instructions.md` document the storage, queue and worker setup
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)

