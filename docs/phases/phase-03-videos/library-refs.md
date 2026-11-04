---
libs:
  "@golevelup/nestjs-rabbitmq":
    version: "^9.1.1"
    context7_id: "/websites/golevelup_github_io_nestjs_modules_rabbitmq"
    fetched_at: "2026-11-04T13:07:58-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T13:07:58-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-04T13:07:58-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-04T10:25:58-03:00"
---

# Library References — phase-03-videos

Cached Context7 excerpts for libraries decided in this phase, distilled to the surfaces Phase 03 uses (RabbitMQ topology/producer/consumer, S3 multipart upload, presigned URLs). Refreshed by `/plan-resolve` when a new library is decided or when the cache is missing for an already-decided TD. Version lines were confirmed against the npm registry; behaviors marked _Verified in 9.1.1_ were checked against the published package typings/source because the Context7 excerpt was silent or ambiguous.

---

## @golevelup/nestjs-rabbitmq

**Version line:** `^9.1.1` (latest on npm). Peer dependencies: `@nestjs/common`/`@nestjs/core` `^11.1.24 || ^12.0.0`, `reflect-metadata ^0.2.2`, `rxjs ^7.8.2` — `nestjs-project` currently declares `^11.0.1` (lockfile 11.1.16), so the Nest packages must be bumped to `^11.1.24` first (SI-03.1).
**Decided in:** `phase-03-videos/TD-01` (Option C — RabbitMQ; client-library sub-decision: golevelup over `@nestjs/microservices` `Transport.RMQ` and raw `amqplib`).
**Context7 ID:** `/websites/golevelup_github_io_nestjs_modules_rabbitmq`.

### 1. Module registration (`forRoot` / `forRootAsync`)

`RabbitMQModule` is built with Nest's `ConfigurableModuleBuilder` (`setClassMethodName('forRoot')`), so both `forRoot(config)` and `forRootAsync({ imports, inject, useFactory })` are available. Exchanges and queues listed in the config are asserted during initialization; if an exchange is not declared, publishing to it may fail.

```typescript
import { MessageHandlerErrorBehavior, RabbitMQModule } from '@golevelup/nestjs-rabbitmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { buildVideoProcessingTopology } from './video-processing.topology';

RabbitMQModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    uri: cfg.url,
    ...buildVideoProcessingTopology(cfg), // { exchanges, queues }
    channels: { default: { prefetchCount: 1, default: true } },
    defaultPublishOptions: { persistent: true },
    defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK, // TD-01: escaping errors → DLX, never requeue
    connectionInitOptions: { wait: true, timeout: 10000 },
  }),
});
```

Relevant config types (_Verified in 9.1.1_, `lib/rabbitmq.interfaces.d.ts`):

```typescript
interface RabbitMQConfig {
  uri: RabbitMQUriConfig | RabbitMQUriConfig[];
  prefetchCount?: number;
  exchanges?: RabbitMQExchangeConfig[];      // { name, type?, createExchangeIfNotExists?, options?: Options.AssertExchange }
  queues?: RabbitMQQueueConfig[];            // module-level queue declaration (see §2)
  channels?: RabbitMQChannels;               // { [name]: { prefetchCount?, default? } }
  defaultPublishOptions?: Options.Publish;
  connectionInitOptions?: ConnectionInitOptions; // { wait?, timeout?, reject? }
  connectionManagerOptions?: AmqpConnectionManagerOptions;
  defaultSubscribeErrorBehavior?: MessageHandlerErrorBehavior;
}
```

- `connectionInitOptions.wait` defaults to `true` (_Verified in 9.1.1_, `defaultConfig` in `lib/amqp/connection.js`); `wait: false` lets the app start before the broker is reachable and relies on `amqp-connection-manager` reconnection.
- Global `prefetchCount` defaults to `10`; Phase 03 sets `prefetchCount: 1` on the default channel so each worker replica holds one job at a time.

### 2. Module-level queue declaration (shared topology)

Declaring queues at module level makes **every** process that imports the module (API and worker) assert the same topology at bootstrap, so the API never publishes into an exchange without a bound queue.

```typescript
interface RabbitMQQueueConfig {          // Verified in 9.1.1
  name: string;
  createQueueIfNotExists?: boolean;      // default true
  options?: Options.AssertQueue;         // durable, arguments: { 'x-queue-type', 'x-delivery-limit', ... }
  exchange?: string;
  routingKey?: string | string[];
  bindQueueArguments?: any;
  consumerTag?: string;
}

export const buildVideoProcessingTopology = (cfg) => ({
  exchanges: [
    { name: 'video.processing', type: 'direct', options: { durable: true } },
    { name: 'video.processing.dlx', type: 'fanout', options: { durable: true } },
  ],
  queues: [
    {
      name: 'video.processing',
      exchange: 'video.processing',
      routingKey: 'video.processing.requested',
      options: {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-delivery-limit': cfg.deliveryLimit,
          'x-dead-letter-exchange': 'video.processing.dlx',
          'x-consumer-timeout': cfg.consumerTimeoutMs,
        },
      },
    },
    {
      name: 'video.processing.retry',
      options: {
        durable: true,
        arguments: {
          'x-queue-type': 'quorum',
          'x-message-ttl': cfg.retryDelayMs,
          'x-dead-letter-exchange': 'video.processing',
          'x-dead-letter-routing-key': 'video.processing.requested',
        },
      },
    },
    {
      name: 'video.processing.dlq',
      exchange: 'video.processing.dlx',
      routingKey: '',
      options: { durable: true, arguments: { 'x-queue-type': 'quorum' } },
    },
  ],
});
```

- Queue arguments are immutable on the broker: re-declaring an existing queue with different arguments fails with `PRECONDITION_FAILED`. Every declarer (module config, `@RabbitSubscribe` `queueOptions`, tests) must import the same constants.
- Quorum queues must be `durable: true`.

### 3. Publishing (`AmqpConnection`)

```typescript
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';

@Injectable()
export class RabbitMqVideoProcessingQueue implements VideoProcessingQueue {
  constructor(private readonly amqp: AmqpConnection) {}

  async requestProcessing(videoId: string): Promise<void> {
    await this.amqp.publish('video.processing', 'video.processing.requested', { videoId }, {
      messageId: videoId,
      persistent: true,
      contentType: 'application/json',
      headers: { 'x-attempt': 1 },
    });
  }

  async scheduleRetry(videoId: string, attempt: number): Promise<void> {
    // default exchange '' routes directly by queue name
    await this.amqp.publish('', 'video.processing.retry', { videoId }, {
      messageId: videoId,
      persistent: true,
      contentType: 'application/json',
      headers: { 'x-attempt': attempt },
    });
  }
}
```

- `publish(exchange, routingKey, message, options?: Options.Publish)` JSON-serializes objects.
- Publishes go through `amqp-connection-manager`, which buffers while disconnected — wrap each publish in a timeout to surface a broker outage as `503 QUEUE_UNAVAILABLE`.

### 4. Consuming (`@RabbitSubscribe`) and ack/nack semantics

```typescript
import { Nack, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import type { ConsumeMessage } from 'amqplib';

@Injectable()
export class VideoProcessingConsumer {
  @RabbitSubscribe({
    queue: 'video.processing',
    queueOptions: VIDEO_PROCESSING_QUEUE_OPTIONS, // same object as the module-level declaration
  })
  async handle(msg: { videoId?: string }, amqpMsg: ConsumeMessage): Promise<void | Nack> {
    if (!isUuid(msg?.videoId)) return new Nack(false); // reject, no requeue → DLX
    // ... claim, process, route failures ...
    // returning normally → ack
  }
}
```

- Handler return value: `undefined` → **ack**; `new Nack()` / `new Nack(false)` → reject **without** requeue (dead-lettered when the queue has `x-dead-letter-exchange`); `new Nack(true)` → reject **with** requeue (immediate redelivery; on quorum queues each redelivery counts toward `x-delivery-limit`).
- The second handler argument is the raw `amqplib` `ConsumeMessage` (`properties.messageId`, `properties.headers['x-attempt']`, `fields.redelivered`).
- `@RabbitSubscribe` asserts the queue again (`createQueueIfNotExists` defaults to `true`) using `queueOptions`; pass the identical options or `createQueueIfNotExists: false` to avoid `PRECONDITION_FAILED`.
- Options also accept `exchange`, `routingKey`, `bindings: [{ exchange, routingKey }]`, `errorBehavior`, `errorHandler` and `allowNonJsonMessages`.
- **Uncaught errors** (_Verified in 9.1.1_, `lib/amqp/connection.js` `setupSubscriberChannel` + `lib/amqp/errorBehaviors.js`): any exception thrown by the handler **or by message deserialization** (body that is not valid JSON) goes to the catch path, which resolves the handler as `msgOptions.errorHandler` → `getHandlerForLegacyBehavior(msgOptions.errorBehavior || config.defaultSubscribeErrorBehavior)`. Mapping: `ACK` → `channel.ack`; `REQUEUE` → `channel.nack(msg, false, true)`; `NACK` (and any other value) → `channel.nack(msg, false, false)`. The library default is `REQUEUE` (immediate redelivery loop until `x-delivery-limit`). Phase 03 sets `defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK` at module level (§1) so the TD-01 rule "uncaught error → nack without requeue" holds: the message is dead-lettered once to `video.processing.dlq` and the sweeper recovers the row from the database.
- Handlers are discovered during application bootstrap, which also happens in `NestFactory.createApplicationContext` (no HTTP listener needed for the worker).

---

## @aws-sdk/client-s3

**Version line:** `^3.1161.0` (latest on npm; keep the same version as `@aws-sdk/s3-request-presigner`).
**Decided in:** `phase-03-videos/TD-02` (Option A — S3 Multipart + presigned `UploadPart`).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### 1. Client configuration for MinIO

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({
  region: cfg.region,                       // e.g. 'us-east-1' (MinIO ignores it but the signer needs it)
  endpoint: cfg.endpoint,                   // internal: http://minio:9000 | presign-only: STORAGE_PUBLIC_ENDPOINT
  forcePathStyle: true,                     // MinIO uses path-style buckets
  credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

- Since SDK 3.729 the default is `WHEN_SUPPORTED`, which adds CRC32 checksum parameters to `PutObject`/`UploadPart`. Baked into a presigned `UploadPart` URL, a browser `PUT` cannot satisfy them — `WHEN_REQUIRED` avoids that.
- Two clients: an internal one (`STORAGE_ENDPOINT`) for server calls, and a presign-only one (`STORAGE_PUBLIC_ENDPOINT`) because the signature covers the host.

### 2. Multipart upload commands

```typescript
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  paginateListParts,
} from '@aws-sdk/client-s3';

const { UploadId } = await s3.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType }));

const parts: { PartNumber: number; ETag: string; Size: number }[] = [];
for await (const page of paginateListParts({ client: s3 }, { Bucket, Key, UploadId })) {
  for (const p of page.Parts ?? []) parts.push({ PartNumber: p.PartNumber!, ETag: p.ETag!, Size: p.Size! });
}

await s3.send(new CompleteMultipartUploadCommand({
  Bucket, Key, UploadId,
  MultipartUpload: { Parts: parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })) }, // ascending PartNumber
}));

await s3.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
```

- `paginateListParts` follows `NextPartNumberMarker` automatically (async iterator).
- S3 limits: parts 5 MiB–5 GiB (last part may be smaller), at most 10 000 parts per upload.

### 3. Object commands

```typescript
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const { ContentLength } = await s3.send(new HeadObjectCommand({ Bucket, Key }));
const { Body } = await s3.send(new GetObjectCommand({ Bucket, Key }));   // Body is a Node Readable in Node runtimes
await s3.send(new PutObjectCommand({ Bucket, Key, Body: jpegBuffer, ContentType: 'image/jpeg' }));
await s3.send(new DeleteObjectCommand({ Bucket, Key }));
```

### 4. Error handling

```typescript
import { S3ServiceException } from '@aws-sdk/client-s3';

try {
  await s3.send(new HeadObjectCommand({ Bucket, Key }));
} catch (e) {
  if (e instanceof S3ServiceException && (e.name === 'NotFound' || e.$metadata.httpStatusCode === 404)) return null;
  throw e;
}
```

- Branch on `e.name` (`NoSuchUpload`, `NoSuchKey`, `NotFound`) or `e.$metadata.httpStatusCode`; `AbortMultipartUpload` on an already-gone upload raises `NoSuchUpload` (treat as success).

---

## @aws-sdk/s3-request-presigner

**Version line:** `^3.1161.0` (same version as `@aws-sdk/client-s3`).
**Decided in:** `phase-03-videos/TD-02` (presigned `UploadPart`) and `phase-03-videos/TD-05` (Option B — presigned `GET`, JSON `{ url, expires_at }`).
**Context7 ID:** `/aws/aws-sdk-js-v3`.

### 1. Presigning `UploadPart` (browser upload)

```typescript
import { UploadPartCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const urls = await Promise.all(
  partNumbers.map(async (PartNumber) => ({
    part_number: PartNumber,
    url: await getSignedUrl(presignClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), {
      expiresIn: cfg.presignExpirySeconds,
    }),
  })),
);
```

- Signing is a local computation (no network call) — batching every part URL in the create response is cheap.
- The browser `PUT`s the raw bytes to each URL and reads the `ETag` response header (requires MinIO CORS `ExposeHeaders: ETag`).

### 2. Presigning `GetObject` (stream, download, thumbnail)

```typescript
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const url = await getSignedUrl(
  presignClient,
  new GetObjectCommand({
    Bucket, Key,
    ResponseContentDisposition: `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(name)}`,
  }),
  { expiresIn: cfg.presignExpirySeconds },
);
const expires_at = new Date(Date.now() + cfg.presignExpirySeconds * 1000).toISOString();
```

- `expiresIn` is in seconds; default `900` when omitted. SigV4 caps it at 7 days.
- `Response*` overrides (`ResponseContentDisposition`, `ResponseContentType`) become signed query parameters — the URL is only valid with exactly those values.
- The storage serves `Range` → `206 Partial Content` natively on presigned `GET`, which is what makes streaming work without proxying bytes through the API.
- Always sign with the presign-only client configured with `STORAGE_PUBLIC_ENDPOINT`; a URL signed for `http://minio:9000` is unusable from the browser and cannot be rewritten after signing.
