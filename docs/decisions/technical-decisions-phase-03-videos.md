---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-04
scope_description: "Backend foundation for video upload and processing: queue technology (the stack decision the project plan leaves as TBD), 10 GB upload strategy, worker process model and FFmpeg integration, unique video URL identifier, streaming/download delivery, video status lifecycle (incl. failure handling and authorization), and object-storage/Compose/config layout."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary subproject. Owns the `videos` module (entity, migration, owner/public controllers, service), the storage adapter over the S3 API (MinIO locally), the queue producer/consumer, the separate worker entrypoint that runs FFmpeg/ffprobe, the new Compose services (`minio`, `minio-init`, `rabbitmq`, `worker`) and the new `registerAs` config namespaces.
- `next-frontend/` — **no open decision in this document.** The Phase 03 brief is backend-only (upload/processing/streaming contracts). Upload and player screens are not part of the Phase 03 capability list and will be researched separately when a frontend slice is opened. The only frontend-facing constraint fixed here is that video bytes never flow through the BFF (TD-02, TD-05), which `next-frontend-config-base/TD-03` already anticipates.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Config pattern:** `registerAs` namespaces + Joi `envValidationSchema` loaded in `ConfigModule.forRoot` (`phase-01-configuracao-base`; wiring in `nestjs-project/src/app.module.ts:16-21`). New namespaces `storage` and `queue` follow it.
> - **Auth & global guards:** global `JwtAuthGuard` + `ThrottlerGuard` (`ttl: 60000, limit: 10`) registered as `APP_GUARD` in `nestjs-project/src/auth/auth.module.ts:29-35`; `@Public()` opts out of JWT (`phase-02-auth/TD-02`, `TD-08`). Any endpoint that is called repeatedly (part signing, status polling) must account for the 10 req/min global limit.
> - **Error envelope:** `{ statusCode, error, message }` via the custom `DomainException` filter (`phase-02-auth/TD-07`). New video error codes extend it; processing failure is a **state**, not an HTTP error.
> - **Validation:** global `ValidationPipe({ whitelist: true, ... })` (`nestjs-project/src/main.ts:19-20`, `phase-02-auth/TD-06`). Clients can never smuggle `bucket`/`key` fields.
> - **"No Redis in the stack":** `phase-02-auth/TD-03` (Pros: "No need for Redis — PostgreSQL (already in stack) suffices") and `phase-02-auth-frontend/TD-02` Option C ("no Redis in the stack"). Weighed in TD-01.
> - **Strict BFF:** `next-frontend-config-base/TD-03` — the browser only talks to `/api/...`; its Option analysis (L142) already states that large video payloads use "presigned URLs from object storage, NOT the backend URL". TD-02 and TD-05 are that mechanism.
> - **Architecture:** `docs/diagrams/software-arch.mermaid` — separate containers `Video Worker (FFmpeg)`, `Object Storage (S3 or MinIO)` and `Message Queue (TBD)`; relations `api → queue "Publishes job"`, `queue → worker "Delivers job"`, `frontend → storage "Streams"`.
> - **Object storage is not an open choice:** S3-compatible; MinIO locally, S3 in production (`README.md:107`). Only *how* it is used is decided here (TD-02, TD-07).

---

## TD-01: Queue Technology for Background Processing

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The project plan leaves the queue as `TBD` (`software-arch.mermaid:13`), and the brief calls it "a principal decisão de stack da fase" (`README.md:102`). Hard constraints: (1) a real queue and worker must start in Docker Compose (auto-fail `README.md:179`); (2) a job lasts long — it downloads a file of up to 10 GB, runs ffprobe and extracts a frame; (3) the database stays the source of truth for video status; (4) the stack currently has no Redis (`phase-02-auth/TD-03`). Payloads are tiny (`{ videoId }`) and throughput is low (one job per uploaded video). Whatever is chosen, the job must survive a worker crash and must not loop forever on a corrupt file.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed job queue with official Nest integration (`@Processor`/`WorkerHost`). Retries with exponential backoff, `jobId` dedupe, stalled-job detection, repeatable jobs and a failed set.
- **Pros:** Real job semantics out of the box (attempts, backoff, delay, repeatable sweeper). Official Nest module. The project's testing guides and vendored skills already use BullMQ examples. Adds a dedicated broker container, matching the C4 diagram literally.
- **Cons:** Introduces Redis, against the "no Redis" stance of `phase-02-auth/TD-03`. Redis must be configured for durability (AOF + `noeviction`) or jobs can vanish. No transactional enqueue with Postgres (needs enqueue-after-commit + sweeper). Lock/stall tuning is needed for multi-minute jobs.

### Option B: pg-boss (queue on the existing PostgreSQL)
- Job queue stored in a `pgboss` schema on the existing database. Uses `SKIP LOCKED`, with retries, backoff and expiry.
- **Pros:** Zero new service. Enqueue can share the business transaction (atomic `draft → processing` + job). Keeps "no Redis".
- **Cons:** No official Nest wrapper (custom provider). A second schema needs an owner alongside TypeORM migrations. It is ambiguous whether a queue inside Postgres satisfies "fila ... real subindo no Compose" (`README.md:179`) and the separate `Message Queue` container in the diagram. Long jobs need `expireIn`/keep-alive tuning.

### Option C: RabbitMQ (AMQP 0-9-1 broker)
- Dedicated message broker container (`rabbitmq:*-management`). The API publishes a persistent message to a durable exchange. The worker consumes from a **quorum queue** with manual acknowledgement and `prefetch 1`.
- **Pros:** A real, dedicated broker that matches the diagram and the Compose criterion unambiguously, while keeping the stack Redis-free. Broker-level at-least-once delivery: a delivery that is not acked is returned to the queue if the consumer dies. Quorum queues bring native poison-message protection (`delivery-limit`, default 20 since RabbitMQ 4.0) and dead-lettering (DLX). The management UI gives visibility during evaluation. Portable to managed AMQP brokers in production, like MinIO → S3.
- **Cons:** A message broker, not a job queue: retry-with-delay, attempt counting and the sweeper are built by us (TTL retry queue + DLX + header counter). No transactional enqueue (enqueue-after-commit + idempotent consumer + sweeper). The delivery-acknowledgement timeout (default 30 min; since RabbitMQ 4.3 enforced only for quorum queues) must be raised for 10 GB jobs. The project's test examples are BullMQ-shaped and must be adapted.

### Option D: SQS-compatible emulator (ElasticMQ / LocalStack)
- SQS API emulated in Compose; SQS in production. Visibility timeout + redrive policy (DLQ).
- **Pros:** Managed-queue story in production. Native DLQ via redrive policy.
- **Cons:** No official Nest transport. The emulator is not the production system, which goes against the "real infra" spirit of the brief. The visibility timeout must be extended manually for long jobs. Adds AWS SDK wiring for a local-only container.

**Recommendation:** **Option A (BullMQ + Redis)** — on the research pass, A scored best: it ships real job semantics (retry/backoff/delay/repeatable sweeper), has an official Nest module (`@nestjs/bullmq`) and matches the project's testing-guide examples. Its cost is a new stateful Redis service that revisits the "no Redis" premise of `phase-02-auth/TD-03`. Option B (pg-boss) leaves the "real queue in Compose" criterion open to interpretation. **The owner chose Option C (see Decision/Note); planning MUST follow C.**
- RabbitMQ runs in Compose (`rabbitmq:<pinned 4.x>-management`) and is consumed through `@golevelup/nestjs-rabbitmq`.
- The API publishes a persistent `{ videoId }` message (`messageId = videoId`) to the durable direct exchange `video.processing` **after** the `draft → processing` commit.
- A publish failure returns `503 QUEUE_UNAVAILABLE`; the row stays `processing` and is re-published by an idempotent `complete` retry or by the sweeper.
- The worker consumes the quorum queue `video.processing` (`x-delivery-limit`, `x-dead-letter-exchange: video.processing.dlx`, a raised `x-consumer-timeout`) with `prefetchCount: 1`. It acks only after the DB reaches a terminal state.
- Transient failures are re-published to the TTL retry queue `video.processing.retry` with an `x-attempt` header, up to `QUEUE_MAX_ATTEMPTS`. Permanent failures set `error` and ack.
- The topology lives in one shared constants module and is asserted by both API and worker at bootstrap.
- The producer sits behind the `VIDEO_PROCESSING_QUEUE` injection token.

**Decision:** C (RabbitMQ)

**Libraries:** @golevelup/nestjs-rabbitmq

**Note:** The decision deliberately diverges from the Recommendation. The rationale:
1. RabbitMQ is the only option that satisfies **both** the dedicated `Message Queue` container (diagram + `README.md:179`) **and** the existing "no Redis in the stack" stance (`phase-02-auth/TD-03`, `phase-02-auth-frontend/TD-02`).
2. It provides broker-level at-least-once delivery, poison-message limits and dead-lettering natively.
3. Its management UI makes the pipeline observable during evaluation.

The accepted costs (job semantics built by hand, enqueue-after-commit, consumer-timeout tuning) are addressed by the invariants below and by TD-06.

**Client library (sub-decision):** `@golevelup/nestjs-rabbitmq` over:
- **`@nestjs/microservices` `Transport.RMQ`** — official, but the consumer must be bootstrapped as an `INestMicroservice` (`NestFactory.createMicroservice` / `connectMicroservice`) rather than the plain application context chosen in TD-03 A. It uses manual `channel.ack()` through `RmqContext`, and payloads travel in Nest's `{ pattern, data }` envelope.
- **Raw `amqplib` + `amqp-connection-manager`** — the most code to own.

golevelup brings:
- decorator handlers (`@RabbitSubscribe`) discovered from any module;
- `AmqpConnection.publish(exchange, routingKey, msg, { persistent: true })`;
- per-channel `prefetchCount`;
- `Nack` return values (`new Nack(false)` → DLX; returning normally → ack; uncaught error → nack without requeue);
- connection resiliency via `amqp-connection-manager` (`connectionInitOptions: { wait: false }`).

**Invariants (regardless of library details):**
- **DB is the source of truth.** The message only says "look at this video": payload `{ videoId }`, `messageId = videoId`, `persistent: true`. The consumer re-reads the row and is idempotent by `videoId` (see TD-06 claim).
- **Topology.** All names and arguments come from **one shared constants module**: mismatched quorum-queue arguments between declarers cause `PRECONDITION_FAILED`.
  - Durable `direct` exchange `video.processing` → quorum queue `video.processing` (routing key `video.processing.requested`). Arguments: `x-queue-type: quorum`, `x-delivery-limit: QUEUE_DELIVERY_LIMIT` (default 3), `x-dead-letter-exchange: video.processing.dlx`, `x-consumer-timeout: QUEUE_CONSUMER_TIMEOUT_MS` (default 2 h).
  - `video.processing.dlx` → `video.processing.dlq` (inspection only).
  - Retry queue `video.processing.retry` with `x-message-ttl: QUEUE_RETRY_DELAY_MS` (default 30 s), dead-lettering back to `video.processing`. The delay is fixed, avoiding per-message-TTL head-of-line blocking.
- **Declared by both processes.** The topology is asserted at bootstrap by **both** the API and the worker, so the API never publishes into an exchange with no bound queue (unroutable messages are silently dropped).
- **Consumer.** `prefetchCount: 1` per worker replica; scale by replicas. Manual ack only after the DB reaches a terminal state.
- **Failure routing.**
  - *Permanent* (corrupt / no video stream / unsupported): set `error`, then ack.
  - *Transient* (storage/DB/network): republish to `video.processing.retry` with an incremented `x-attempt` header, then ack. Once `QUEUE_MAX_ATTEMPTS` (default 3) is reached: set `error`, then ack.
  - *Crash / timeout*: the broker redelivers; `delivery-limit` exhausted → DLQ. The TD-06 sweeper then closes the row.
- **Enqueue-after-commit.** The `draft → processing` UPDATE commits first, then the message is published. A publish failure surfaces as `503 QUEUE_UNAVAILABLE`; the row stays `processing`, and both a client retry of the idempotent `complete` endpoint and the sweeper re-publish (TD-06).
- **Port.** The producer sits behind a `VIDEO_PROCESSING_QUEUE` injection token, so the API's unit tests mock the port. Integration tests hit the real RabbitMQ in Compose.

---

## TD-02: Large-File (10 GB) Upload Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** A 10 GB file must not "travar o sistema" (auto-fail `README.md:178`), and the upload must be resumable after a connection failure (`docs/project-plan.md:165`). The brief points to "upload direto ao storage via URL pré-assinada / multipart, em vez de passar o arquivo pela API" (`README.md:103`). The draft row must exist as soon as the upload starts (`docs/project-plan.md:76`). The global throttler allows 10 requests/min per client, so a per-part signing call would starve a 160-part upload.

**Options:**

### Option A: S3 Multipart Upload with presigned `UploadPart` URLs
- The API creates the draft and calls `CreateMultipartUpload`, then returns presigned `UploadPart` URLs. The client PUTs the parts **directly to storage** and calls `complete`. The server finalizes with `ListParts` + `CompleteMultipartUpload`.
- **Pros:** Zero video bytes through the API. Natively resumable: `ListParts` tells exactly which parts exist. Parallel parts. Identical on MinIO and S3. Uses the official AWS SDK v3 only.
- **Cons:** Multi-step protocol (init → parts → complete/abort). Browser uploads need storage CORS exposing `ETag`. Orphaned multipart uploads need a lifecycle rule. A presigned PUT cannot enforce the declared size, so it must be checked after the upload.

### Option B: tus resumable protocol (`tusd` container or `@tus/server`)
- An open resumable-upload protocol. A `tusd` sidecar writes to S3. A Nest-embedded `@tus/server` would proxy the bytes.
- **Pros:** Mature resumability semantics and client (`tus-js-client`).
- **Cons:** Either a new service (`tusd`) plus hook plumbing back to the API, or bytes back through the Node process (embedded). Adds a protocol on top of S3 where S3 multipart already solves the problem.

### Option C: Single presigned `PUT`
- One presigned URL for the whole object.
- **Pros:** Simplest possible flow.
- **Cons:** Not resumable — a dropped connection at 9.9 GB restarts from zero. S3 caps a single PUT at 5 GB, which is below the 10 GB target. Disqualified.

### Option D: Stream the upload through the API (Multer/busboy → SDK)
- The API receives the multipart/form-data body and streams it to storage.
- **Pros:** A single authorization point; no CORS.
- **Cons:** Every byte crosses Node; long-lived 10 GB requests tie up the API. This is exactly the auto-fail scenario (`README.md:178`). Disqualified.

**Recommendation:** **Option A (S3 Multipart + presigned `UploadPart`)** — the only option that keeps video bytes off the API, is natively resumable and needs no new service. Plan it as:
- Owner routes live under `channels/:channelId/videos`.
- `POST` inserts the `draft` and calls `CreateMultipartUpload`. It returns `upload_id`, `part_size_bytes` (default 64 MiB) and all part URLs signed in one batch (throttler 10/60 s). If S3 fails after the INSERT, it compensates to `error` + `503 STORAGE_UNAVAILABLE`.
- `GET .../uploads/parts` resumes via `ListParts` and re-signs only the missing parts.
- `POST .../uploads/complete` is idempotent and server-authoritative (`ListParts` → `CompleteMultipartUpload` → `HeadObject` size check, `422 UPLOAD_SIZE_MISMATCH`), followed by the conditional `draft → processing` transition.
- `POST .../uploads/abort` aborts and sets `error`.
- Keys are server-generated (TD-07). `content_type` is allow-listed and the size is capped by `STORAGE_MAX_UPLOAD_BYTES` (10 GiB).
- A second presign-only S3 client uses `STORAGE_PUBLIC_ENDPOINT`.
- MinIO CORS exposes `ETag`, and an `AbortIncompleteMultipartUpload` lifecycle rule cleans orphans.

**Decision:** A (S3 Multipart + presigned `UploadPart`)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Implementation constraints carried into the plan (detail):**
- **Routes.** Owner routes are nested under `channels/:channelId/videos`.
  - `POST` creates the `draft` and calls `CreateMultipartUpload`. It returns `upload_id`, `part_size_bytes` and **all** part URLs signed **in one batch**, to stay within the 10/60 s throttler.
  - If the S3 call fails after the INSERT, the draft is moved to `error` and the endpoint answers `503 STORAGE_UNAVAILABLE`. Never leave a draft without an upload.
- **Part size.** 64 MiB by default (≈160 parts for 10 GiB), configurable. S3 limits: 5 MiB minimum part, 10 000 parts maximum. "10 GB" is enforced as `STORAGE_MAX_UPLOAD_BYTES` (default 10 GiB = 10 737 418 240 bytes).
- **Resume.** `GET .../uploads/parts` calls `ListParts` (paginated) and re-signs **only** the missing parts.
- **Complete is idempotent and server-authoritative.**
  - Parts come from `ListParts`; client-supplied ETags are not trusted.
  - `CompleteMultipartUpload` runs, then `HeadObject.ContentLength` must equal `size_bytes` (`422 UPLOAD_SIZE_MISMATCH` otherwise).
  - The conditional `draft → processing` UPDATE guarantees a single transition (TD-06).
- **Abort.** `POST .../uploads/abort` calls `AbortMultipartUpload` and moves the draft to `error` (`UPLOAD_ABORTED`).
- **Keys are always generated server-side** (TD-07 layout). The `content_type` is checked against an allow-list at registration; authoritative validation is ffprobe in the worker (TD-03).
- **Two S3 clients.** Signing is a local computation and the signature covers the host:
  - an internal client for server calls (`STORAGE_ENDPOINT=http://minio:9000`);
  - a **presign-only** client for URLs the browser will use (`STORAGE_PUBLIC_ENDPOINT`, e.g. `http://localhost:9000`).
- **MinIO CORS** must allow `PUT` from the frontend origin and **expose `ETag`**. This only shows up in a real browser; Node tests will not catch it.
- **Orphans.** A bucket lifecycle rule `AbortIncompleteMultipartUpload` (1 day) plus the TD-06 sweeper for stale drafts.

---

## TD-03: Worker Process Model and FFmpeg Integration

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Metadata extraction is heavy and must run in the background without blocking the user (`docs/project-plan.md:166`). The diagram has a separate `Video Worker (FFmpeg)` container, and the brief asks "como o worker roda (processo/container separado) e como ele extrai metadados e gera o thumbnail (FFmpeg/ffprobe)" (`README.md:104`). Today `nestjs-project` is a single Nest app: `nest-cli.json` is single-project, `Dockerfile.dev` is `node:25.6.0-slim` with only `procps curl`, and the TypeORM config is inline in `nestjs-project/src/app.module.ts:22-35`. The integration tests run inside the `nestjs-api` container, so any binary the worker needs must also be available there for tests.

**Options:**

### Option A: Nest standalone application context in its own entrypoint + Compose service
- `src/worker/main.ts` bootstraps `NestFactory.createApplicationContext(WorkerModule)` (no HTTP listener) and calls `enableShutdownHooks()`. `WorkerModule` imports config, TypeORM, storage and the RabbitMQ module with the consumer, and **not** `AuthModule`/controllers (no global `APP_GUARD`s).
- It runs as a separate `worker` service in Compose, from the same image family and the same `node_modules`.
- **Pros:** True process/container isolation from the API (CPU-heavy FFmpeg cannot starve HTTP). Reuses the DI, config, entities and repositories of the API codebase with no duplication. Scales by replicas. Matches the diagram. With TD-01's golevelup, handlers are discovered on application bootstrap, so no microservice server is needed.
- **Cons:** The inline TypeORM config must first be extracted into a reusable factory/module. Needs a new npm script and a Compose `command`. Shared code changes can affect both processes.

### Option B: Consumers inside the API process
- `@RabbitSubscribe` handlers live in the API's `AppModule`.
- **Pros:** No new entrypoint or service.
- **Cons:** FFmpeg and 10 GB downloads compete with HTTP for CPU, memory and the event loop. Contradicts "processo/container separado" and the diagram. A deploy of the API kills in-flight jobs. Disqualified.

### Option C: Nest monorepo (`nest g app worker`, `projects` in `nest-cli.json`)
- A second Nest application with its own `tsconfig`/`main`, plus shared libs.
- **Pros:** First-class separation of builds.
- **Cons:** Invasive restructure of a working single-app repo (paths, build, jest config, Dockerfile) for a single extra entrypoint. Option A delivers the same runtime isolation without it.

**Recommendation:** **Option A (Nest standalone context in its own entrypoint)** — true process/container isolation from the API, with full reuse of DI, config, entities and repositories and no repo restructuring. Plan it as:
- `src/worker/main.ts` bootstraps `NestFactory.createApplicationContext(WorkerModule)` + `enableShutdownHooks()`.
- `WorkerModule` imports config, a TypeORM factory extracted from `app.module.ts:22-35`, storage and the RabbitMQ consumer — never `AuthModule`/controllers.
- A `worker` Compose service runs it from the same image.
- `ffmpeg`/`ffprobe` are installed via `apt` in the shared `Dockerfile.dev` (no npm FFmpeg wrappers). They are invoked with `node:child_process` `spawn` using argument arrays, `-protocol_whitelist file` and a typed timeout/exit-code wrapper.
- The original is streamed to `WORKER_SCRATCH_DIR` and removed in `finally`.
- `ffprobe -print_format json -show_format -show_streams` yields the duration (`format.duration` with stream fallback) and a curated metadata subset.
- The thumbnail is `ffmpeg -ss <~10% of duration> -i <file> -frames:v 1 -vf scale=640:-2` (JPEG), uploaded to the thumbnails bucket.
- On `SIGTERM` the worker stops consuming, and an unacked job is redelivered.

**Decision:** A (Nest standalone context in its own entrypoint)

**FFmpeg integration (detail):**
- **Install.** `ffmpeg` (which provides `ffprobe`) is installed via `apt` in the **shared** `nestjs-project/Dockerfile.dev`. Both `nestjs-api` (integration tests) and `worker` then have it. No `ffmpeg-static`/`fluent-ffmpeg` packages are used.
- **Invocation.** `node:child_process` `spawn` with an **argument array** (no shell), wrapped in a small typed helper (timeout, stderr capture, exit-code mapping). The source file name is never interpolated into a command.
- **Source.** The original is downloaded (streamed `GetObject`) to a scratch volume (`WORKER_SCRATCH_DIR`) and processed locally. This covers MP4s with `moov` at the end and keeps the tests deterministic. The scratch file is removed in `finally`.
- **Metadata.** `ffprobe -v error -print_format json -show_format -show_streams -- <file>`. Duration comes from `format.duration`, falling back to the video stream's duration. A **curated** subset (codec, width, height, fps, bitrate, container) is persisted — never the raw JSON, whose tags can carry PII. No video stream, invalid duration or an unsupported container is a *permanent* failure.
- **Thumbnail.**
  - Command: `ffmpeg -ss <offset> -i <file> -frames:v 1 -vf scale=640:-2 -q:v 3 <out>.jpg`, with `-ss` **before** `-i` for a fast seek.
  - The offset is ~10 % of the duration, with a floor for very short clips.
  - The result is uploaded to the thumbnails bucket (TD-07).
- **Hardening.** `-protocol_whitelist file` (input is already local; blocks SSRF via playlists/`concat`). Non-root user (the image already runs as `node`). CPU/memory limits on the Compose service. User-facing messages never include stderr.
- **Lifecycle.**
  - On `SIGTERM` the worker stops consuming and lets the current job finish or abandons it (unacked → redelivered).
  - `stop_grace_period` is larger than the default.
  - Health is checked via `pgrep`/process (`procps` is already installed).
- **No new npm library:** Node core `child_process`; `ffmpeg` is an OS package.

---

## TD-04: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique URL that "nunca conflite com outro vídeo"; the attention point also says "curta" (`docs/project-plan.md:167`). The same identifier will back Phase 04 *unlisted* links ("somente via link", `docs/project-plan.md:95`), so it must be **unguessable**. Every existing entity uses a UUID primary key generated by Postgres: `@PrimaryGeneratedColumn('uuid')` in `nestjs-project/src/users/entities/user.entity.ts:13` and `nestjs-project/src/channels/entities/channel.entity.ts:14`, and `DEFAULT uuid_generate_v4()` in `nestjs-project/src/database/migrations/1775687773260-CreateUsersAndChannels.ts:8`.

**Options:**

### Option A: Separate random base62 `public_id` (11–12 chars)
- A new `UNIQUE` column generated in the API with `node:crypto`, retrying a bounded number of times on `23505`.
- **Pros:** Short, YouTube-like URLs. ≈65+ bits of entropy (unguessable). The link can be rotated without touching the PK.
- **Cons:** Extra column, index, generator and a retry path on unique violation, with SAVEPOINT handling when the insert runs inside a transaction. Two identifiers per video to keep straight in code and tests.

### Option B: UUID v4 (the entity's primary key)
- The URL uses the `videos.id` UUID v4 generated by `uuid_generate_v4()`, like every other entity.
- **Pros:** Collision-free by construction, so there is no retry loop and no `23505` path. 122 random bits — unguessable, with no ordering or time leakage — which is safe for unlisted links. Zero extra column, index or code. Follows the existing entity convention. `ParseUUIDPipe` validates the route param for free.
- **Cons:** 36 characters, so not "curta". A leaked link cannot be rotated without changing the PK (a future additive `public_id` column would be needed). It exposes the internal identifier, which is harmless for random v4 values.

### Option C: Sequential ID encoded with Sqids/Hashids
- Short IDs derived from a sequence.
- **Pros:** Short, no collisions.
- **Cons:** Reversible and enumerable — unsuitable for Phase 04 unlisted links. Disqualified.

### Option D: Title slug
- `/videos/my-first-video`.
- **Pros:** Readable.
- **Cons:** Guessable, collides, and changes when Phase 04 edits the title (breaks links). Disqualified.

**Recommendation:** **Option A (separate base62 `public_id`)** — on the research pass it was the only option satisfying both "curta" and "unguessable", at the cost of a generator, an extra unique column and a `23505` retry path. **The owner chose Option B (see Decision/Note); planning MUST follow B:**
- The URL identifier is the video's primary key `id` (UUID v4 from `uuid_generate_v4()` via `@PrimaryGeneratedColumn('uuid')`, as in every existing entity).
- The `videos` table has no `public_id` column.
- Public routes are `/videos/:id`, validated with `ParseUUIDPipe`.
- Storage keys use the same `{videoId}`.
- No collision-retry code is needed.

**Decision:** B (UUID v4 — the video's primary key)

**Note:** The decision deliberately diverges from the Recommendation. The binding capability is "URL única por vídeo, sem conflito com outros vídeos" (`docs/project-plan.md:79`); UUID v4 meets it by construction, with no collision-handling code. It also keeps the codebase-wide `uuid` PK convention and gives unlisted links (Phase 04) 122 bits of unguessability. The "curta" wording in the attention point (`docs/project-plan.md:167`) is consciously traded for zero extra schema and code. If short or rotatable links are required later, an additive `public_id` column can be introduced without breaking existing UUID URLs. Consequences for the plan:
- the `videos` table has **no** `public_id` column;
- public routes are `/videos/:id` with `ParseUUIDPipe`;
- storage keys also use `{videoId}` (TD-07).

---

## TD-05: Streaming and Download Delivery

**Scope:** Backend

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Playback must start without downloading the whole file (`docs/project-plan.md:169`); the brief cites "requisições com range / 206 Partial Content" (`README.md:105`). The diagram has `frontend → storage "Streams"` — the storage serves bytes, not the API. Under strict BFF, the Next.js server would proxy anything the API returns as bytes, or any redirect it follows server-side. The global throttler (10/min) would break if each Range request hit the API.

**Options:**

### Option A: Proxy through the API (`StreamableFile` + `Range`/`206`/`416`)
- The API reads from storage and pipes byte ranges to the client.
- **Pros:** A single authorization point on every byte; no storage exposure.
- **Cons:** The API (and the BFF) become byte proxies for 10 GB files. Nest does not implement `Range`/`If-Range` by itself (custom code). Every seek is an API request, hitting the throttler. Scales poorly.

### Option B: Presigned `GET` returned by the API
- The API authorizes the request and returns a short-lived presigned `GET` URL. The browser `<video>` element fetches directly from storage, which handles `Range` → `206 Partial Content` natively. The response is either JSON `{ url, expires_at }` or a `302`.
- **Pros:** The storage does what it is built for (Range/206, throughput). The API is called about once per playback session. Matches the diagram and `next-frontend-config-base/TD-03` (L142). Download is the same mechanism with `response-content-disposition=attachment`.
- **Cons:** URLs are bearer tokens until they expire. The player must re-request a URL if it seeks after expiry (`403` from storage). The URL must be signed with the browser-reachable host (TD-02 presign-only client). Storage CORS must allow `GET` from the frontend origin.

### Option C: HLS/DASH adaptive streaming
- Transcode into renditions and segments, served via playlists.
- **Pros:** Adaptive bitrate; industry standard at scale.
- **Cons:** Transcoding pipeline, ≈3–5× storage, and much longer processing. Out of scope for Phase 03 (the deliverable is "streaming funcionando", not adaptive streaming).

### Option D: Public bucket / CDN
- Objects are publicly readable.
- **Pros:** Simplest delivery.
- **Cons:** Anyone with a key reads anything, which defeats Phase 04 *unlisted* semantics and non-`ready` gating. Disqualified.

**Recommendation:** **Option B (Presigned `GET`, JSON response)** — the storage serves `Range`/`206 Partial Content` natively, the API is hit about once per playback session (no throttler pressure), and it matches the diagram's `frontend → storage "Streams"` and `next-frontend-config-base/TD-03`. JSON `{ url, expires_at }` is preferred over `302`: under strict BFF, the Next.js server would follow the redirect and proxy the video. Plan it as:
- `@Public()` endpoints returning `200 { url, expires_at }`:
  - `GET /videos/:id/stream`
  - `GET /videos/:id/download`, signed with `ResponseContentDisposition: attachment` and a sanitized/RFC 5987 filename
  - `GET /videos/:id/thumbnail`
- `GET /videos/:id` returns metadata.
- All public routes answer only for `status = ready` and return `404 VIDEO_NOT_FOUND` otherwise.
- URLs are signed with the presign-only public-endpoint client and expire after `STORAGE_PRESIGN_EXPIRY_SECONDS` (default 3600). The player re-requests on a storage `403`.

**Decision:** B (Presigned `GET`, JSON `{ url, expires_at }`)

**Libraries:** @aws-sdk/s3-request-presigner

**Implementation constraints carried into the plan (detail):**
- **Endpoints.** `GET /videos/:id/stream`, `GET /videos/:id/download` and `GET /videos/:id/thumbnail` are `@Public()` and return `200 { url, expires_at }`.
  - `download` signs with `ResponseContentDisposition: attachment; filename="<sanitized original name>"` (RFC 5987 `filename*` for non-ASCII).
  - `GET /videos/:id` returns public metadata.
- **Visibility before Phase 04.** Public only when `status = ready`; any other status, or an unknown id, returns `404 VIDEO_NOT_FOUND` (no existence leak). Owners see non-ready videos through the owner route (TD-06).
- **TTL.** `STORAGE_PRESIGN_EXPIRY_SECONDS` (default 3600). The player/BFF re-requests on a storage `403`.

---

## TD-06: Video Status Lifecycle, Failure Handling and Authorization

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The brief requires the cycle "rascunho → processando → pronto/erro" reflected in the database (`README.md:98`, `README.md:159`) and asks "o que acontece em caso de falha no processamento" (`README.md:106`). Status is written by two processes (the API and the worker). Messages can be duplicated (at-least-once, TD-01), and a crash can leave rows stuck. Phase 04 will add its own "rascunho → publicação" flow and visibility (`docs/project-plan.md:95-96`), which must not be conflated with media processing. Owner-only operations need channel ownership checks; public reads must not leak unfinished videos.

**Options:**

### Option A: 4-state media status enum + columns for details + conditional transitions + sweeper
- A Postgres enum `videos_status_enum` with `draft | processing | ready | error`. Upload/processing details (`upload_id`, `error_code`, `error_message`, `processing_started_at`, `processing_attempts`, `processed_at`) live in **columns**, not extra states.
- Transitions are `UPDATE ... WHERE id = $1 AND status = <expected>`, checking the affected rows.
- A periodic sweeper repairs stuck rows.
- **Pros:** Exactly the brief's cycle; minimal and testable. Idempotent transitions without row locks. Leaves publication/visibility orthogonal for Phase 04 (no rename or backfill later).
- **Cons:** Finer upload sub-states (`uploading` vs `uploaded`) are derived from columns rather than visible in `status`.

### Option B: Extended state machine (`uploading`, `uploaded`, `queued`, `processing`, `ready`, `failed`, ...)
- Every step is a status value.
- **Pros:** Very explicit progress for the UI.
- **Cons:** Diverges from the brief's cycle. More transitions to guard and test. Several states carry no behavior today.

### Option C: Single column mixing media and publication (`draft`/`published`/`processing`/...)
- Phase 03 and Phase 04 states share one column.
- **Pros:** One field to read.
- **Cons:** Conflates "the file is processed" with "the owner published it". Phase 04 would need to rename/backfill. Combinations such as "ready but not published" become awkward.

**Recommendation:** **Option A (4-state media status + conditional transitions + sweeper)** — it is exactly the brief's "rascunho → processando → pronto/erro" cycle, keeps transitions idempotent without row locks, and leaves Phase 04 publication/visibility orthogonal. Plan it as:
- **Enum.** Postgres `videos_status_enum` = `draft | processing | ready | error` (English values mapping 1:1 to the brief's labels, like the existing `verification_tokens_type_enum`), default `draft`.
- **Detail columns.** `upload_id`, `error_code`, `error_message`, `processing_started_at`, `processing_attempts`, `processed_at`.
- **Transitions** via `UPDATE ... WHERE status = <expected>`:
  - `draft → processing` by the idempotent `complete`;
  - `processing → ready|error` by the worker;
  - `draft → error` on abort, expiry or init failure;
  - anything else → `409`.
- **Claim.** The worker claims with a lease-guarded conditional UPDATE and drops duplicates.
- **Failures.** Permanent → `error` immediately; transient → retry per TD-01, then `error`. `error_code`s are stable and user-safe.
- **Sweeper.** A periodic task in the worker expires stale drafts (`UPLOAD_EXPIRED`), re-publishes never-claimed `processing` rows and times out stuck ones (`PROCESSING_TIMEOUT`).
- **Owner routes.** `channels/:channelId/videos/...` require JWT + a `ChannelsService` ownership guard: `403` for non-owners, and `videoId` is always scoped by `channelId`.
- **Public routes.** `/videos/:id...` are `@Public()` and return `404` unless `ready`.
- **Throttling.** The polled owner-detail and part-resign endpoints get `@Throttle` overrides.

**Decision:** A (4-state media status + conditional transitions + sweeper)

**Lifecycle rules (detail):**
- **Enum values** are English identifiers `draft`, `processing`, `ready`, `error`, mapping 1:1 to the brief's labels "rascunho → processando → pronto/erro". This follows the existing enum convention (`verification_tokens_type_enum` = `'email_confirmation', 'password_reset'` in `nestjs-project/src/database/migrations/1777579850478-CreateAuthTokens.ts:8`). The default is `draft`.
- **Transitions:**
  - `draft → processing` — API `complete`; idempotent: if the row is already `processing`, the endpoint re-publishes and returns `202`.
  - `processing → ready | error` — worker.
  - `draft → error` — abort, upload expiry, or storage failure at init.
  - `error → processing` — reserved for a later owner "retry" action; not exposed in Phase 03.
  - Any other transition is a `409`.
- **Worker claim (dedupe of at-least-once):**
  - `UPDATE videos SET processing_started_at = now(), processing_attempts = processing_attempts + 1 WHERE id = $1 AND status = 'processing' AND (processing_started_at IS NULL OR processing_started_at < now() - <lease>)`.
  - 0 rows affected → ack and drop (duplicate or already terminal).
  - Outputs go to deterministic keys (TD-07), so reprocessing overwrites instead of duplicating.
- **Failure handling:**
  - Permanent failures go straight to `error`.
  - Transient failures retry per TD-01 and end in `error` after `QUEUE_MAX_ATTEMPTS`.
  - Stable `error_code`s: `INVALID_MEDIA`, `UNSUPPORTED_CODEC`, `PROCESSING_FAILED`, `PROCESSING_TIMEOUT`, `UPLOAD_EXPIRED`, `UPLOAD_ABORTED`.
  - `error_message` is user-safe (no stderr or paths).
  - Catch-log-retry is confined to the worker (background); the API lets errors surface through the domain filter.
- **Sweeper** (periodic task inside the worker process):
  1. `draft` older than `VIDEO_DRAFT_TTL_HOURS` → `AbortMultipartUpload` + `error/UPLOAD_EXPIRED`.
  2. `processing` never claimed for longer than a grace period → re-publish (covers a lost publish after commit).
  3. `processing` claimed longer than `QUEUE_CONSUMER_TIMEOUT_MS` → re-publish while attempts remain, otherwise `error/PROCESSING_TIMEOUT`.
- **Authorization:**
  - **Owner routes:** `channels/:channelId/videos/...` (create, parts, complete, abort, owner detail with any status and `error_*` fields).
    - They require JWT and ownership through a guard that delegates to a `ChannelsService` ownership check (to be added; today `nestjs-project/src/channels/channels.service.ts` only has `createChannel`).
    - `videoId` is always scoped by `channelId` in queries (anti-IDOR).
    - Non-owner → `403`; missing → `404`.
  - **Public routes:** `/videos/:id...` are `@Public()` and gated on `ready` (non-ready → `404`). Owner and public behavior are never mixed in the same route.
  - **Throttling.** The owner detail endpoint will be polled while processing, so it needs a dedicated `@Throttle` override. The same applies to the part-resign endpoint. The global 10/min limit is otherwise kept.

---

## TD-07: Object Storage Layout, Compose Infrastructure and Configuration

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Storage is S3-compatible (MinIO locally, S3 in production — `README.md:107`). What is decided is the bucket/key organization and how storage, queue and worker start in Compose (auto-fail `README.md:179`). "Vídeos grandes consomem muito espaço ... planejar o crescimento e os custos" (`docs/project-plan.md:168`). Today `nestjs-project/compose.yaml` has `nestjs-api`, `db` (Postgres 17, **no volume**) and `mailpit`. Config follows `registerAs` + Joi (`nestjs-project/src/app.module.ts:16-21`), and `.env.example` has no storage or queue keys.

**Options:**

### Option A: Two buckets (`videos`, `thumbnails`) + per-channel/per-video key prefixes
- Keys:
  - `videos/{channelId}/{videoId}/original.{ext}`
  - `thumbnails/{channelId}/{videoId}/thumbnail.jpg`
- `ext` is derived from the validated content type, **never** from the client filename.
- **Pros:** Independent policies and lifecycles per bucket (e.g. a multipart-abort rule only on `videos`; thumbnails could later become CDN-public without exposing originals). Deterministic keys make reprocessing idempotent. Prefixes allow per-channel usage accounting (`mc du`) and bulk deletion (Phase 04 deletes). No path traversal or PII from filenames.
- **Cons:** Two buckets to create and configure (handled by a one-shot init container).

### Option B: Single bucket with type prefixes (`media/videos/...`, `media/thumbnails/...`)
- **Pros:** One bucket to provision.
- **Cons:** Policies and lifecycle rules become prefix-filtered and easier to get wrong. A future public-thumbnail policy sits next to private originals.

### Option C: Flat keys by video id only (`{videoId}.mp4`)
- **Pros:** Simplest keys.
- **Cons:** No per-channel accounting or bulk deletion, and no room for future renditions.

**Recommendation:** **Option A (two buckets + `{channelId}/{videoId}/...` keys)** — independent policies and lifecycles per bucket, deterministic keys that make reprocessing idempotent, per-channel accounting and bulk deletion, and no filename-derived paths. Plan it as:
- **Buckets.** `videos` (`{channelId}/{videoId}/original.{ext}`, with `ext` from the validated content type) and `thumbnails` (`{channelId}/{videoId}/thumbnail.jpg`).
- **Compose services:**
  - `minio` (volume `minio-data`, healthcheck);
  - one-shot `minio-init` (`mc`: buckets, CORS exposing `ETag`, `AbortIncompleteMultipartUpload` lifecycle); dependants wait on `service_completed_successfully`;
  - `rabbitmq` (`-management`, volume `rabbitmq-data`, healthcheck `rabbitmq-diagnostics -q ping`);
  - `worker` (same build, real command, `worker-scratch` volume, grace period, resource limits).
- All image tags are pinned.
- `db` also gets a named volume, so rows and objects persist together.
- **Config.** New `registerAs('storage')`/`registerAs('queue')` namespaces with Joi keys and `.env.example` entries (`STORAGE_*`, `RABBITMQ_URL`, `QUEUE_*`, `WORKER_SCRATCH_DIR`, `VIDEO_DRAFT_TTL_HOURS`). Test helpers read exactly the same variable names.
- Phase 03 stores only the original plus one thumbnail (no renditions).

**Decision:** A (two buckets + `{channelId}/{videoId}/...` keys)

**Compose and configuration (detail):**
- **New services in `nestjs-project/compose.yaml`:**
  - `minio` (S3 API `9000`, console `9001`, named volume `minio-data`, healthcheck).
  - `minio-init` (`minio/mc`, one-shot). It creates both buckets, applies CORS (allow `PUT`/`GET` from the frontend origin, expose `ETag`) and the `AbortIncompleteMultipartUpload` lifecycle rule. `nestjs-api` and `worker` depend on it via `condition: service_completed_successfully`.
  - `rabbitmq` (`rabbitmq:<pinned 4.x>-management`, ports `5672`/`15672`, named volume `rabbitmq-data`, healthcheck `rabbitmq-diagnostics -q ping`).
  - `worker` (same build as `nestjs-api`, real `command` that starts `src/worker/main.ts`, `restart: unless-stopped`, named volume `worker-scratch`, `stop_grace_period`, CPU/memory limits, `depends_on` db/minio-init/rabbitmq healthy).
- **Image tags are pinned exactly.** MinIO community image distribution and licensing changed recently, so `/plan-resolve` must confirm an available tag.
- **Persistence hazard:** `db` currently has no volume. Persisting only MinIO and RabbitMQ would let objects and messages outlive their rows after `down`/`up`. Persist `db` as well (named volume), or none.
- **Env inventory** — one canonical name per concept, and the test helpers read **exactly** the same variables:

  | Area | Variables |
  |---|---|
  | `storage` namespace | `STORAGE_ENDPOINT`, `STORAGE_PUBLIC_ENDPOINT`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_FORCE_PATH_STYLE`, `STORAGE_BUCKET_VIDEOS`, `STORAGE_BUCKET_THUMBNAILS`, `STORAGE_PRESIGN_EXPIRY_SECONDS`, `STORAGE_MAX_UPLOAD_BYTES`, `STORAGE_PART_SIZE_BYTES` |
  | `queue` namespace | `RABBITMQ_URL`, `QUEUE_DELIVERY_LIMIT`, `QUEUE_CONSUMER_TIMEOUT_MS`, `QUEUE_RETRY_DELAY_MS`, `QUEUE_MAX_ATTEMPTS` |
  | worker | `WORKER_SCRATCH_DIR`, `VIDEO_DRAFT_TTL_HOURS` |
  | Compose-only | `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` (= storage credentials), `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS` |

  All are added to the Joi schema and `.env.example`.
- **Growth and cost:** Phase 03 stores only the original plus one thumbnail (no renditions; HLS later would multiply storage ≈3–5×). No bucket versioning. Per-channel quotas stay an open product question, not a Phase 03 requirement. In production, egress dominates video cost — another reason for presigned direct delivery (TD-05).
- **No new npm library** beyond TD-02's AWS SDK packages (MinIO and RabbitMQ are container images).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Queue technology for background processing | **A** (BullMQ + Redis) | **C** (RabbitMQ, via `@golevelup/nestjs-rabbitmq`) |
| TD-02 | Backend | Large-file (10 GB) upload strategy | **A** (S3 Multipart + presigned `UploadPart`) | **A** |
| TD-03 | Backend | Worker process model and FFmpeg integration | **A** (Nest standalone context, own entrypoint/service) | **A** |
| TD-04 | Backend | Unique video URL identifier | **A** (separate base62 `public_id`) | **B** (UUID v4 primary key) |
| TD-05 | Backend | Streaming and download delivery | **B** (Presigned `GET`, JSON) | **B** (JSON `{ url, expires_at }`) |
| TD-06 | Backend | Status lifecycle, failure handling and authorization | **A** (4-state enum + conditional transitions + sweeper) | **A** |
| TD-07 | Backend | Storage layout, Compose and configuration | **A** (two buckets + `{channelId}/{videoId}` keys) | **A** |

---

## Notes for downstream pipeline

- **Divergent TDs carry binding guidance inside `**Recommendation:**`.** `decisions-detail-reader` copies only the `**Recommendation:**` paragraph and the `**Libraries:**` line into `context.md`. For TD-01 and TD-04, where the owner's Decision differs from the research recommendation, the paragraph therefore ends with "The owner chose Option X …; planning MUST follow X" plus the build constraints. `/plan-build` must implement the **Decision** (RabbitMQ; UUID v4 PK), never BullMQ or a base62 `public_id`.
- **Coverage.** All nine Phase 03 capability bullets (`docs/project-plan.md:73-81`) are covered: storage → TD-07; queue → TD-01; 10 GB upload + draft → TD-02/TD-06; metadata + thumbnail → TD-03; unique URL → TD-04; streaming + download → TD-05.
- **Dependency: TD-01 ↔ TD-03.**
  - The worker is a `createApplicationContext` process. golevelup discovers `@RabbitSubscribe` handlers on application bootstrap, which `createApplicationContext` runs. Confirm in `/plan-resolve` that no HTTP/microservice server is required.
  - If golevelup ever had to be replaced by `@nestjs/microservices`, TD-03 A would switch to `NestFactory.createMicroservice` (same entrypoint and Compose service).
- **Peer-dependency gate (golevelup).** `@golevelup/nestjs-rabbitmq@9.1.1` (latest; deps `amqplib`, `amqp-connection-manager`) declares peers `@nestjs/core`/`@nestjs/common` `^11.1.24 || ^12.0.0`, and 8.x already required `^11.1.17`. `nestjs-project/package-lock.json` resolves `@nestjs/core`/`@nestjs/common` **11.1.16**. `/plan-build` must include a first step bumping the `@nestjs/*` packages within `^11` (≥ 11.1.24) before installing golevelup. No major upgrade is involved.
- **To verify via Context7 in `/plan-resolve`** (`library-refs.md` is expected for this phase):
  - **golevelup:** queue declaration with `queueOptions.arguments` (`x-queue-type`, `x-delivery-limit`, `x-dead-letter-exchange`, `x-consumer-timeout`); a module-level `queues`/topology option vs `AmqpConnection.channel` asserts; publisher confirms; `defaultPublishOptions`.
  - **RabbitMQ 4.x:** quorum-queue `x-consumer-timeout` as a queue argument, `delivery-limit` semantics, TTL retry-queue pattern, image tag and healthcheck.
  - **AWS SDK v3:** `CreateMultipartUpload`/`UploadPart` presign/`ListParts` pagination/`CompleteMultipartUpload`/`AbortMultipartUpload`/`HeadObject`, `forcePathStyle`, `ResponseContentDisposition`.
  - **MinIO:** `mc` bucket, CORS and lifecycle (`ilm`) commands and healthcheck.
  - **Nest:** `createApplicationContext` + `enableShutdownHooks`, `nest start --entryFile`.
  - **`@nestjs/throttler` v6:** `@Throttle` per-route override.
- **Facts already confirmed during research (Context7):**
  - **RabbitMQ 4.3 delivery-acknowledgement timeout:** default 30 min. Configurable per consumer/queue (`x-consumer-timeout`), per policy (`consumer-timeout`) or globally (`consumer_timeout` in `rabbitmq.conf`). Since 4.3 it is only supported by quorum queues.
  - **Quorum queues:** `delivery-limit` defaults to 20 (since 4.0); messages exceeding it are dropped or dead-lettered.
  - **golevelup:** `Nack` semantics (return normally → ack; `new Nack(false)` → DLX; uncaught error → nack without requeue). Resilient connections via `amqp-connection-manager`.
  - **Nest RMQ transporter:** `noAck: false` for manual ack, `prefetchCount`, `queueOptions`; consumers need `createMicroservice`/`connectMicroservice`.
- **Repo prerequisites for `/plan-build`:**
  1. Add `ffmpeg` to `nestjs-project/Dockerfile.dev` (`apt install -y procps curl ffmpeg`).
  2. Extract the inline TypeORM options from `nestjs-project/src/app.module.ts:22-35` into a reusable factory shared by `AppModule` and `WorkerModule`.
  3. Add `storage`/`queue` `registerAs` namespaces plus Joi keys, and complete `.env.example`.
  4. Add a `start:worker:dev` script.
  5. Add the migration for `videos` (with no `public_id` column — see TD-04) and its `videos_status_enum`.
  6. Add `videos` to the test DB cleanup helper.
  7. Add a `ChannelsService` ownership query and guard.
- **Testing implications.** Unit tests mock the `VIDEO_PROCESSING_QUEUE` port and the storage port. Integration tests use the real Postgres, MinIO and RabbitMQ from Compose, plus `ffprobe`/`ffmpeg` in the `nestjs-api` container, against a tiny fixture video (a few seconds). The project's testing guide shows BullMQ-style processor tests (`process(job)` called directly); the equivalent here is calling the `@RabbitSubscribe` handler method directly with a `{ videoId }` payload.
- **Copilot instructions.** The brief requires the instructions to gain a coherent "videos" section once implemented: the worker entrypoint, queue topology, storage layout, status lifecycle, and the "no bytes through the API" rule.

Sources consulted during research:

- `README.md` (challenge brief) — Phase 03 scope (L83-109), research requirement (L113-115), acceptance criteria (L143-172), auto-fail conditions (L174-183).
- `docs/project-plan.md` — Phase 03 capabilities (L67-83), Phase 04 publication/visibility (L87-98), Pontos de Atenção (L163-171).
- `docs/diagrams/software-arch.mermaid` — container and relation model (`Message Queue (TBD)`, `Video Worker (FFmpeg)`, `frontend → storage "Streams"`).
- `docs/decisions/technical-decisions-phase-02-auth.md`, `technical-decisions-phase-02-auth-frontend.md`, `technical-decisions-next-frontend-config-base.md` — inherited constraints listed in the cross-doc anchors.
- `nestjs-project/compose.yaml`, `Dockerfile.dev`, `.env.example`, `src/app.module.ts`, `src/main.ts`, `src/auth/auth.module.ts`, `src/channels/channels.service.ts`, entity and migration files — current baseline.
- [RabbitMQ 4.3 — Consumers: delivery acknowledgement timeout](https://www.rabbitmq.com/docs/4.3/consumers) and [Quorum Queues: consumer timeout, poison message handling, dead lettering](https://www.rabbitmq.com/docs/4.3/quorum-queues).
- [NestJS 11 — RabbitMQ transporter](https://github.com/nestjs/docs.nestjs.com/blob/11.0.0/content/microservices/rabbitmq.md), [Standalone applications](https://github.com/nestjs/docs.nestjs.com/blob/11.0.0/content/application-context.md), [Hybrid application](https://github.com/nestjs/docs.nestjs.com/blob/11.0.0/content/faq/hybrid-application.md).
- [`@golevelup/nestjs-rabbitmq` documentation](https://golevelup.github.io/nestjs/modules/rabbitmq.html) — handlers, `Nack`, `publish`, channels/prefetch, connection management. npm registry metadata for versions and peer dependencies.
- Prior research reports for this phase: two exploratory reports (session artifacts, not committed) that listed the options for each decision and the best fit before the owner's choices were recorded here.
