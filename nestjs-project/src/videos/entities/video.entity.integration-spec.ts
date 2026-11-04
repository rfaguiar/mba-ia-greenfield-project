import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { ALL_ENTITIES } from '../../test/all-entities';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let users: Repository<User>;
  let channels: Repository<Channel>;
  let videos: Repository<Video>;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    users = dataSource.getRepository(User);
    channels = dataSource.getRepository(Channel);
    videos = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  async function createChannel(): Promise<Channel> {
    const user = await users.save(
      users.create({
        email: `video-entity-${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channels.save(
      channels.create({
        name: 'Video owner',
        nickname: `video_owner_${counter}`,
        user_id: user.id,
      }),
    );
  }

  async function createVideo(channelId: string): Promise<Video> {
    return videos.save(
      videos.create({
        channel_id: channelId,
        title: 'Sample video',
        original_filename: 'sample.mp4',
        content_type: 'video/mp4',
        size_bytes: 10737418240,
      }),
    );
  }

  it('applies lifecycle defaults and maps bigint sizes to numbers', async () => {
    const channel = await createChannel();
    const saved = await createVideo(channel.id);
    const loaded = await videos.findOneByOrFail({ id: saved.id });

    expect(loaded.status).toBe(VideoStatus.DRAFT);
    expect(loaded.processing_attempts).toBe(0);
    expect(loaded.size_bytes).toBe(10737418240);
    expect(loaded.duration_seconds).toBeNull();
    expect(loaded.metadata).toBeNull();
    expect(loaded.error_code).toBeNull();
  });

  it('enforces the status enum and channel foreign key', async () => {
    await expect(
      dataSource.query(
        `INSERT INTO videos
          (channel_id, title, original_filename, content_type, size_bytes, status)
         VALUES ($1, 'title', 'video.mp4', 'video/mp4', 1, 'unknown')`,
        ['00000000-0000-4000-8000-000000000001'],
      ),
    ).rejects.toThrow();

    await expect(
      dataSource.query(
        `INSERT INTO videos
          (channel_id, title, original_filename, content_type, size_bytes)
         VALUES ($1, 'title', 'video.mp4', 'video/mp4', 1)`,
        ['00000000-0000-4000-8000-000000000001'],
      ),
    ).rejects.toThrow();
  });

  it('prevents deleting a channel while it owns videos', async () => {
    const channel = await createChannel();
    await createVideo(channel.id);

    await expect(channels.delete(channel.id)).rejects.toThrow();
  });
});
