import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { ALL_ENTITIES } from '../test/all-entities';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { createTestStorage } from '../test/create-test-storage';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import {
  VIDEO_PROCESSING_EXCHANGE,
  VIDEO_PROCESSING_ROUTING_KEY,
} from '../queue/video-processing.topology';
import { originalKey, thumbnailKey } from '../storage/storage-keys';

describe('Video processing over real RabbitMQ (integration)', () => {
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let lifecycle: VideoLifecycleService;
  let worker: ChildProcess | undefined;
  let storage: ReturnType<typeof createTestStorage> | undefined;
  let scratchDirectory: string;
  let channelId: string;
  let originalObjectKey: string;
  let thumbnailObjectKey: string;
  let virtualHost: string;
  let brokerUrl: URL;
  const fixtureDirectory = join(process.cwd(), 'test', 'fixtures', 'videos');

  beforeAll(async () => {
    const configuredUrl = process.env.RABBITMQ_URL;
    if (!configuredUrl) throw new Error('RABBITMQ_URL is required');
    const databaseName = process.env.DB_DATABASE;
    if (!databaseName?.startsWith('streamtube_phase3_')) {
      throw new Error(
        'DB_DATABASE must name an isolated streamtube_phase3_ test database',
      );
    }

    virtualHost = `phase03-${randomUUID()}`;
    brokerUrl = new URL(configuredUrl);
    await createIsolatedVirtualHost(brokerUrl, virtualHost);
    brokerUrl.pathname = `/${virtualHost}`;

    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    lifecycle = new VideoLifecycleService(videos);

    scratchDirectory = await mkdtemp(
      join(tmpdir(), 'streamtube-rabbit-worker-'),
    );
    worker = await startWorker({
      ...process.env,
      DB_NAME: databaseName,
      RABBITMQ_URL: brokerUrl.toString(),
      WORKER_SCRATCH_DIR: scratchDirectory,
    });
  }, 90000);

  afterAll(async () => {
    await stopWorker(worker);
    if (dataSource?.isInitialized) await dataSource.destroy();
    if (scratchDirectory) {
      await rm(scratchDirectory, { recursive: true, force: true });
    }
    if (virtualHost && brokerUrl) {
      await deleteIsolatedVirtualHost(brokerUrl, virtualHost);
    }
  }, 30000);

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await users.save(
      users.create({
        email: `rabbit-worker-${randomUUID()}@example.com`,
        password: 'hashed',
      }),
    );
    const ownerChannel = await channels.save(
      channels.create({
        name: 'Rabbit worker owner',
        nickname: `rabbit_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        user_id: user.id,
      }),
    );
    channelId = ownerChannel.id;
    storage = createTestStorage();
  });

  afterEach(async () => {
    await cleanAllTables(dataSource);
    if (storage) {
      if (originalObjectKey) {
        await storage.client
          .send(
            new DeleteObjectCommand({
              Bucket: storage.settings.bucketVideos,
              Key: originalObjectKey,
            }),
          )
          .catch(() => undefined);
      }
      if (thumbnailObjectKey) {
        await storage.client
          .send(
            new DeleteObjectCommand({
              Bucket: storage.settings.bucketThumbnails,
              Key: thumbnailObjectKey,
            }),
          )
          .catch(() => undefined);
      }
      storage.client.destroy();
      storage.presignClient.destroy();
      storage = undefined;
    }
    originalObjectKey = '';
    thumbnailObjectKey = '';
  });

  it('publishes a job to RabbitMQ and completes processing in the worker process', async () => {
    const sample = await readFile(join(fixtureDirectory, 'sample-2s.mp4'));
    const video = await lifecycle.createDraft({
      channelId,
      title: 'RabbitMQ integration fixture',
      originalFilename: 'sample-2s.mp4',
      contentType: 'video/mp4',
      sizeBytes: sample.length,
    });
    await lifecycle.startProcessing(video.id);
    originalObjectKey = originalKey(channelId, video.id, video.content_type);
    thumbnailObjectKey = thumbnailKey(channelId, video.id);
    await storage!.client.send(
      new PutObjectCommand({
        Bucket: storage!.settings.bucketVideos,
        Key: originalObjectKey,
        Body: sample,
        ContentType: video.content_type,
      }),
    );

    await publishVideoProcessingMessage(brokerUrl, virtualHost, video.id);
    const processed = await waitForVideo(videos, video.id, 45000);

    expect(processed.status).toBe(VideoStatus.READY);
    expect(processed.duration_seconds).toBeGreaterThanOrEqual(1.9);
    expect(processed.metadata).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
    });
    await expect(
      storage!.client.send(
        new HeadObjectCommand({
          Bucket: storage!.settings.bucketThumbnails,
          Key: thumbnailObjectKey,
        }),
      ),
    ).resolves.toMatchObject({ ContentType: 'image/jpeg' });
  }, 60000);
});

async function startWorker(
  environment: NodeJS.ProcessEnv,
): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register',
      '-r',
      'tsconfig-paths/register',
      'src/worker/main.ts',
    ],
    {
      cwd: process.cwd(),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    output += chunk;
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Worker startup timed out: ${output.slice(-2000)}`));
      }, 60000);
      child.stdout?.on('data', checkReady);
      child.stderr?.on('data', checkReady);
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        reject(
          new Error(
            `Worker exited before startup (code=${code}, signal=${signal}): ${output.slice(-2000)}`,
          ),
        );
      });

      function checkReady(): void {
        if (!output.includes('Video processing worker started')) return;
        clearTimeout(timeout);
        resolve();
      }
    });
  } catch (error) {
    await stopWorker(child);
    throw error;
  }

  return child;
}

async function stopWorker(worker: ChildProcess | undefined): Promise<void> {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    worker.once('error', reject);
    worker.once('exit', () => resolve());
    worker.kill('SIGTERM');
  });
}

async function waitForVideo(
  videos: Repository<Video>,
  videoId: string,
  timeoutMs: number,
): Promise<Video> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const video = await videos.findOneByOrFail({ id: videoId });
    if (
      video.status === VideoStatus.READY ||
      video.status === VideoStatus.ERROR
    ) {
      return video;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for worker to process video ${videoId}`);
}

async function createIsolatedVirtualHost(
  connectionUrl: URL,
  virtualHost: string,
): Promise<void> {
  const authorization = managementAuthorization(connectionUrl);
  const baseUrl = managementUrl(connectionUrl, virtualHost);
  const response = await fetch(baseUrl, {
    method: 'PUT',
    headers: { authorization },
  });
  if (response.status !== 201 && response.status !== 204) {
    throw new Error(
      `Could not create isolated RabbitMQ vhost (${response.status})`,
    );
  }

  const username = encodeURIComponent(
    decodeURIComponent(connectionUrl.username),
  );
  const permissions = await fetch(
    `http://${connectionUrl.hostname}:15672/api/permissions/${encodeURIComponent(virtualHost)}/${username}`,
    {
      method: 'PUT',
      headers: {
        authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ configure: '.*', write: '.*', read: '.*' }),
    },
  );
  if (permissions.status !== 201 && permissions.status !== 204) {
    throw new Error(
      `Could not grant permissions on isolated RabbitMQ vhost (${permissions.status})`,
    );
  }
}

async function deleteIsolatedVirtualHost(
  connectionUrl: URL,
  virtualHost: string,
): Promise<void> {
  const response = await fetch(managementUrl(connectionUrl, virtualHost), {
    method: 'DELETE',
    headers: { authorization: managementAuthorization(connectionUrl) },
  });
  if (response.status !== 204 && response.status !== 404) {
    throw new Error(
      `Could not delete isolated RabbitMQ vhost (${response.status})`,
    );
  }
}

function managementUrl(connectionUrl: URL, virtualHost: string): string {
  return `http://${connectionUrl.hostname}:15672/api/vhosts/${encodeURIComponent(virtualHost)}`;
}

function managementAuthorization(connectionUrl: URL): string {
  const username = decodeURIComponent(connectionUrl.username);
  const password = decodeURIComponent(connectionUrl.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

async function publishVideoProcessingMessage(
  connectionUrl: URL,
  virtualHost: string,
  videoId: string,
): Promise<void> {
  const exchange = encodeURIComponent(VIDEO_PROCESSING_EXCHANGE);
  const response = await fetch(
    `http://${connectionUrl.hostname}:15672/api/exchanges/${encodeURIComponent(virtualHost)}/${exchange}/publish`,
    {
      method: 'POST',
      headers: {
        authorization: managementAuthorization(connectionUrl),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        properties: {
          delivery_mode: 2,
          message_id: videoId,
          content_type: 'application/json',
          headers: { 'x-attempt': 1 },
        },
        routing_key: VIDEO_PROCESSING_ROUTING_KEY,
        payload: JSON.stringify({ videoId }),
        payload_encoding: 'string',
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Could not publish video processing job (${response.status})`,
    );
  }
  const result = (await response.json()) as { routed?: unknown };
  if (result.routed !== true) {
    throw new Error('RabbitMQ did not route the video processing job');
  }
}
