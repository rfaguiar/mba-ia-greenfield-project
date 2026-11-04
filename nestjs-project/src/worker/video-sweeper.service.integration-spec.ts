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
import { originalKey } from '../storage/storage-keys';
import { VideoProcessingQueue } from '../queue/video-processing.queue';
import { VideoSweeperService } from './video-sweeper.service';

describe('VideoSweeperService (integration)', () => {
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let lifecycle: VideoLifecycleService;
  let channelId: string;
  let storage: ReturnType<typeof createTestStorage>;
  let queue: VideoProcessingQueue & {
    requestProcessing: jest.Mock;
    scheduleRetry: jest.Mock;
  };
  let sweeper: VideoSweeperService;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
    lifecycle = new VideoLifecycleService(videos);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await users.save(
      users.create({
        email: `sweeper-${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'Sweeper owner',
        nickname: `sweeper_${counter}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
    storage = createTestStorage();
    queue = {
      requestProcessing: jest.fn().mockResolvedValue(undefined),
      scheduleRetry: jest.fn().mockResolvedValue(undefined),
    };
    sweeper = new VideoSweeperService(
      lifecycle,
      storage.storage,
      queue,
      storage.settings,
      { scratchDir: 'unused', videoDraftTtlHours: 24 },
      {
        url: 'amqp://streamtube:streamtube@rabbitmq:5672',
        deliveryLimit: 3,
        consumerTimeoutMs: 60 * 60 * 1000,
        retryDelayMs: 1000,
        maxAttempts: 3,
      },
    );
  });

  afterEach(async () => {
    storage.client.destroy();
    storage.presignClient.destroy();
  });

  async function createVideo(
    status: VideoStatus,
    title = 'Sweeper video',
  ): Promise<Video> {
    const video = await lifecycle.createDraft({
      channelId,
      title,
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });
    if (status === VideoStatus.PROCESSING) {
      await lifecycle.startProcessing(video.id);
    }
    return video;
  }

  it('expires stale drafts, aborts their multipart uploads, and recovers processing rows', async () => {
    const draft = await createVideo(VideoStatus.DRAFT);
    const draftKey = originalKey(channelId, draft.id, draft.content_type);
    const uploadId = await storage.storage.createMultipartUpload(
      draftKey,
      draft.content_type,
    );
    await lifecycle.attachUploadId(draft.id, uploadId);
    await dataSource.query(
      `UPDATE videos SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1`,
      [draft.id],
    );

    const unclaimed = await createVideo(
      VideoStatus.PROCESSING,
      'Unclaimed video',
    );
    await dataSource.query(
      `UPDATE videos SET updated_at = NOW() - INTERVAL '20 minutes' WHERE id = $1`,
      [unclaimed.id],
    );

    const leased = await createVideo(VideoStatus.PROCESSING, 'Leased video');
    await dataSource.query(
      `UPDATE videos
       SET processing_started_at = NOW() - INTERVAL '2 hours',
           processing_attempts = 1
       WHERE id = $1`,
      [leased.id],
    );

    const exhausted = await createVideo(
      VideoStatus.PROCESSING,
      'Exhausted video',
    );
    await dataSource.query(
      `UPDATE videos
       SET processing_started_at = NOW() - INTERVAL '2 hours',
           processing_attempts = 3
       WHERE id = $1`,
      [exhausted.id],
    );

    await sweeper.sweep();

    const expiredDraft = await videos.findOneByOrFail({ id: draft.id });
    expect(expiredDraft.status).toBe(VideoStatus.ERROR);
    expect(expiredDraft.error_code).toBe('UPLOAD_EXPIRED');
    await expect(
      storage.storage.listUploadedParts(draftKey, uploadId),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });

    expect(queue.requestProcessing).toHaveBeenCalledWith(unclaimed.id);
    expect(queue.requestProcessing).toHaveBeenCalledWith(leased.id, 2);

    const timedOut = await videos.findOneByOrFail({ id: exhausted.id });
    expect(timedOut.status).toBe(VideoStatus.ERROR);
    expect(timedOut.error_code).toBe('PROCESSING_TIMEOUT');
  });

  it('keeps stale drafts unaffected when a concurrent transition wins', async () => {
    const draft = await createVideo(VideoStatus.DRAFT);
    await dataSource.query(
      `UPDATE videos SET created_at = NOW() - INTERVAL '25 hours' WHERE id = $1`,
      [draft.id],
    );
    const failDraft = jest
      .spyOn(lifecycle, 'failDraft')
      .mockResolvedValueOnce(false);

    await sweeper.sweep();

    expect(failDraft).toHaveBeenCalledWith(draft.id, 'UPLOAD_EXPIRED');
    expect((await videos.findOneByOrFail({ id: draft.id })).status).toBe(
      VideoStatus.DRAFT,
    );
  });
});
