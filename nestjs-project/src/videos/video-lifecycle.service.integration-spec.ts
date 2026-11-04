import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/all-entities';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';

describe('VideoLifecycleService (integration)', () => {
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let lifecycle: VideoLifecycleService;
  let channelId: string;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    lifecycle = new VideoLifecycleService(dataSource.getRepository(Video));
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await users.save(
      users.create({
        email: `video-lifecycle-${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channels.save(
      channels.create({
        name: 'Owner',
        nickname: `owner_${counter}`,
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  async function createDraft() {
    return lifecycle.createDraft({
      channelId,
      title: 'Video',
      originalFilename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    });
  }

  it('allows only one concurrent draft-to-processing transition', async () => {
    const video = await createDraft();

    const transitions = await Promise.all([
      lifecycle.startProcessing(video.id),
      lifecycle.startProcessing(video.id),
    ]);

    expect(transitions.filter(Boolean)).toHaveLength(1);
    const updated = await dataSource.getRepository(Video).findOneByOrFail({
      id: video.id,
    });
    expect(updated.status).toBe(VideoStatus.PROCESSING);
    expect(updated.processing_attempts).toBe(0);
  });

  it('allows only one active lease claim and increments attempts after expiry', async () => {
    const video = await createDraft();
    await lifecycle.startProcessing(video.id);

    const claims = await Promise.all([
      lifecycle.claim(video.id, 60000),
      lifecycle.claim(video.id, 60000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);

    await dataSource.query(
      `UPDATE videos SET processing_started_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`,
      [video.id],
    );
    const reclaimed = await lifecycle.claim(video.id, 60000);
    expect(reclaimed?.processing_attempts).toBe(2);
  });

  it('releases claims without resetting attempts and marks ready conditionally', async () => {
    const video = await createDraft();
    await lifecycle.startProcessing(video.id);
    await lifecycle.claim(video.id, 60000);
    await lifecycle.releaseClaim(video.id);

    const reclaimed = await lifecycle.claim(video.id, 60000);
    expect(reclaimed?.processing_attempts).toBe(2);

    const result = await lifecycle.markReady(video.id, {
      durationSeconds: 2,
      metadata: {
        container: 'mp4',
        codec: 'h264',
        width: 320,
        height: 240,
        fps: 25,
        bitrate: 1200,
      },
    });
    expect(result).toBe(true);

    const ready = await dataSource.getRepository(Video).findOneByOrFail({
      id: video.id,
    });
    expect(ready.status).toBe(VideoStatus.READY);
    expect(ready.duration_seconds).toBe(2);
    expect(ready.metadata?.codec).toBe('h264');
    expect(ready.processed_at).toBeInstanceOf(Date);
    expect(ready.error_code).toBeNull();
  });

  it('filters owner lookups by both channel and video id', async () => {
    const video = await createDraft();
    const foreignUser = await users.save(
      users.create({
        email: `foreign-${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    const foreignChannel = await channels.save(
      channels.create({
        name: 'Foreign',
        nickname: `foreign_${counter}`,
        user_id: foreignUser.id,
      }),
    );

    await expect(
      lifecycle.findOwned(foreignChannel.id, video.id),
    ).resolves.toBeNull();
    await expect(
      lifecycle.findOwned(channelId, video.id),
    ).resolves.toMatchObject({
      id: video.id,
    });
  });
});
