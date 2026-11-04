import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { App } from 'supertest/types';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import {
  VideoE2eContext,
  VideoE2eOwner,
  closeVideoE2eContext,
  createVideoE2eContext,
  createVideoE2eOwner,
  resetVideoE2eState,
  videoAuthHeaders,
} from './video-e2e.helpers';

describe('Owner video routes (e2e)', () => {
  jest.setTimeout(30000);

  let context: VideoE2eContext;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let owner: VideoE2eOwner;
  let foreignOwner: VideoE2eOwner;

  beforeAll(async () => {
    context = await createVideoE2eContext();
    app = context.app;
    dataSource = context.dataSource;
  });

  afterAll(async () => {
    await closeVideoE2eContext(context);
  });

  beforeEach(async () => {
    await resetVideoE2eState(context);
    owner = await createVideoE2eOwner(app, `owner-${randomUUID()}@example.com`);
  });

  async function seedVideo(
    channelId: string,
    status: VideoStatus,
  ): Promise<Video> {
    return dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        channel_id: channelId,
        title: `A ${status} video`,
        original_filename: 'original.mp4',
        content_type: 'video/mp4',
        size_bytes: 10,
        status,
        upload_id: null,
        duration_seconds: status === VideoStatus.READY ? 2 : null,
        metadata:
          status === VideoStatus.READY
            ? {
                container: 'mov,mp4',
                codec: 'h264',
                width: 320,
                height: 240,
                fps: 25,
                bitrate: 12000,
              }
            : null,
        error_code: status === VideoStatus.ERROR ? 'INVALID_MEDIA' : null,
        error_message:
          status === VideoStatus.ERROR ? 'The file is not a valid video' : null,
        processed_at: status === VideoStatus.READY ? new Date() : null,
      }),
    );
  }

  it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.ERROR])(
    'returns owner details for status %s without internal fields',
    async (status) => {
      const video = await seedVideo(owner.channelId, status);
      const response = await request(app.getHttpServer())
        .get(`/channels/${owner.channelId}/videos/${video.id}`)
        .set(videoAuthHeaders(owner.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        id: video.id,
        channel_id: owner.channelId,
        status,
        title: `A ${status} video`,
      });
      expect(response.body).not.toHaveProperty('upload_id');
      expect(response.body).not.toHaveProperty('processing_started_at');
    },
  );

  it('returns 404 for another channel video and 400 for malformed UUIDs', async () => {
    const video = await seedVideo(owner.channelId, VideoStatus.DRAFT);
    foreignOwner = await createVideoE2eOwner(
      app,
      `foreign-${randomUUID()}@example.com`,
    );
    await request(app.getHttpServer())
      .get(`/channels/${foreignOwner.channelId}/videos/${video.id}`)
      .set(videoAuthHeaders(foreignOwner.accessToken))
      .expect(404);
    await request(app.getHttpServer())
      .get(`/channels/${owner.channelId}/videos/not-a-uuid`)
      .set(videoAuthHeaders(owner.accessToken))
      .expect(400);
  });
});
