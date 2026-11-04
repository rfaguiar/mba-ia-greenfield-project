import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/all-entities';
import { createTestStorage } from '../test/create-test-storage';
import { originalKey, thumbnailKey } from '../storage/storage-keys';
import { MediaProbeService } from './media/media-probe.service';
import { ThumbnailService } from './media/thumbnail.service';
import { VideoProcessingQueue } from '../queue/video-processing.queue';
import { VideoProcessingConsumer } from './video-processing.consumer';

jest.mock('@golevelup/nestjs-rabbitmq', () => ({
  Nack: class Nack {
    constructor(public readonly requeue: boolean) {}
  },
  RabbitSubscribe: () => () => undefined,
}));

describe('VideoProcessingConsumer (integration)', () => {
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let lifecycle: VideoLifecycleService;
  let channelId: string;
  let scratchDirectory: string;
  let consumer: VideoProcessingConsumer;
  let storage: ReturnType<typeof createTestStorage>;
  const objectKeys: string[] = [];
  let counter = 0;
  const videosBucket = process.env.STORAGE_BUCKET_VIDEOS ?? 'videos';
  const thumbnailsBucket =
    process.env.STORAGE_BUCKET_THUMBNAILS ?? 'thumbnails';
  const fixtureDirectory = join(process.cwd(), 'test', 'fixtures', 'videos');

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    lifecycle = new VideoLifecycleService(videos);
    scratchDirectory = await mkdtemp(join(tmpdir(), 'streamtube-worker-'));
  });

  afterAll(async () => {
    await rm(scratchDirectory, { recursive: true, force: true });
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await users.save(
      users.create({
        email: `worker-${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'Worker owner',
        nickname: `worker_${counter}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    storage = createTestStorage();
    const queue: VideoProcessingQueue = {
      requestProcessing: jest.fn().mockResolvedValue(undefined),
      scheduleRetry: jest.fn().mockResolvedValue(undefined),
    };
    consumer = new VideoProcessingConsumer(
      lifecycle,
      storage.storage,
      new MediaProbeService(),
      new ThumbnailService(),
      queue,
      storage.settings,
      { scratchDir: scratchDirectory, videoDraftTtlHours: 24 },
      {
        url: 'amqp://streamtube:streamtube@rabbitmq:5672',
        deliveryLimit: 3,
        consumerTimeoutMs: 7_200_000,
        maxAttempts: 3,
        retryDelayMs: 1000,
      },
    );
  });

  afterEach(async () => {
    for (const key of objectKeys.splice(0)) {
      for (const bucket of [videosBucket, thumbnailsBucket]) {
        await storage.client
          .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
          .catch(() => undefined);
      }
    }
    storage.client.destroy();
    storage.presignClient.destroy();
  });

  async function createProcessingVideo(
    filename: string,
    content: Buffer,
  ): Promise<Video> {
    const video = await lifecycle.createDraft({
      channelId,
      title: 'Worker fixture',
      originalFilename: filename,
      contentType: 'video/mp4',
      sizeBytes: content.length,
    });
    await lifecycle.startProcessing(video.id);
    const key = originalKey(channelId, video.id, video.content_type);
    objectKeys.push(key, thumbnailKey(channelId, video.id));
    await storage.client.send(
      new PutObjectCommand({
        Bucket: videosBucket,
        Key: key,
        Body: content,
        ContentType: video.content_type,
      }),
    );
    return video;
  }

  it('processes a real video, publishes its thumbnail, and ignores redelivery', async () => {
    const sample = await readFile(join(fixtureDirectory, 'sample-2s.mp4'));
    const video = await createProcessingVideo('sample.mp4', sample);

    await consumer.handle({ videoId: video.id });

    const ready = await videos.findOneByOrFail({ id: video.id });
    expect(ready.status).toBe(VideoStatus.READY);
    expect(ready.duration_seconds).toBeGreaterThanOrEqual(1.9);
    expect(ready.duration_seconds).toBeLessThanOrEqual(2.1);
    expect(ready.metadata).toMatchObject({
      codec: 'h264',
      width: 320,
      height: 240,
      fps: 25,
    });
    const thumbnail = await storage.client.send(
      new HeadObjectCommand({
        Bucket: thumbnailsBucket,
        Key: thumbnailKey(channelId, video.id),
      }),
    );
    expect(thumbnail.ContentType).toBe('image/jpeg');

    await consumer.handle({ videoId: video.id });
    const redelivered = await videos.findOneByOrFail({ id: video.id });
    expect(redelivered.processing_attempts).toBe(1);
  });

  it('marks random bytes as INVALID_MEDIA', async () => {
    const invalid = await readFile(join(fixtureDirectory, 'not-a-video.mp4'));
    const video = await createProcessingVideo('invalid.mp4', invalid);

    await consumer.handle({ videoId: video.id });

    const failed = await videos.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.ERROR);
    expect(failed.error_code).toBe('INVALID_MEDIA');
  });
});
