import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { App } from 'supertest/types';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { originalKey, thumbnailKey } from '../src/storage/storage-keys';
import {
  VideoE2eContext,
  VideoE2eOwner,
  closeVideoE2eContext,
  createVideoE2eContext,
  createVideoE2eOwner,
  resetVideoE2eState,
} from './video-e2e.helpers';

describe('Public video routes (e2e)', () => {
  jest.setTimeout(30000);

  let context: VideoE2eContext;
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let owner: VideoE2eOwner;
  const keys: Array<{ bucket: string; key: string }> = [];
  const videoBucket = process.env.STORAGE_BUCKET_VIDEOS ?? 'videos';
  const thumbnailBucket = process.env.STORAGE_BUCKET_THUMBNAILS ?? 'thumbnails';

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
    owner = await createVideoE2eOwner(
      app,
      `public-${randomUUID()}@example.com`,
    );
  });

  afterEach(async () => {
    for (const { bucket, key } of keys.splice(0)) {
      try {
        await context.s3.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: key }),
        );
      } catch {
        // The object may not have been created if the test failed early.
      }
    }
  });

  async function seedReadyVideo(
    status: VideoStatus = VideoStatus.READY,
  ): Promise<Video> {
    const video = await dataSource.getRepository(Video).save(
      dataSource.getRepository(Video).create({
        channel_id: owner.channelId,
        title: 'Public sample',
        original_filename: 'sample.mp4',
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
        processed_at: status === VideoStatus.READY ? new Date() : null,
      }),
    );

    if (status === VideoStatus.READY) {
      const sourceKey = originalKey(
        owner.channelId,
        video.id,
        video.content_type,
      );
      const imageKey = thumbnailKey(owner.channelId, video.id);
      keys.push(
        { bucket: videoBucket, key: sourceKey },
        { bucket: thumbnailBucket, key: imageKey },
      );
      await context.s3.send(
        new PutObjectCommand({
          Bucket: videoBucket,
          Key: sourceKey,
          Body: Buffer.from('0123456789'),
          ContentType: video.content_type,
        }),
      );
      await context.s3.send(
        new PutObjectCommand({
          Bucket: thumbnailBucket,
          Key: imageKey,
          Body: Buffer.from('thumbnail'),
          ContentType: 'image/jpeg',
        }),
      );
    }
    return video;
  }

  it('serves ready metadata and presigned stream, download, and thumbnail URLs', async () => {
    const video = await seedReadyVideo();
    const metadata = await request(app.getHttpServer())
      .get(`/videos/${video.id}`)
      .expect(200);
    expect(metadata.body).toMatchObject({
      id: video.id,
      title: 'Public sample',
      duration_seconds: 2,
      metadata: { codec: 'h264', width: 320, height: 240 },
    });

    const stream = await request(app.getHttpServer())
      .get(`/videos/${video.id}/stream`)
      .expect(200);
    const rangeResponse = await fetch(stream.body.url, {
      headers: { Range: 'bytes=0-4' },
    });
    expect(rangeResponse.status).toBe(206);
    expect(rangeResponse.headers.get('content-range')).toBe('bytes 0-4/10');
    expect(await rangeResponse.text()).toBe('01234');

    const download = await request(app.getHttpServer())
      .get(`/videos/${video.id}/download`)
      .expect(200);
    const downloadResponse = await fetch(download.body.url);
    expect(downloadResponse.status).toBe(200);
    expect(downloadResponse.headers.get('content-disposition')).toMatch(
      /^attachment/,
    );

    const thumbnail = await request(app.getHttpServer())
      .get(`/videos/${video.id}/thumbnail`)
      .expect(200);
    const thumbnailResponse = await fetch(thumbnail.body.url);
    expect(thumbnailResponse.status).toBe(200);
    expect(thumbnailResponse.headers.get('content-type')).toMatch(
      /image\/jpeg/,
    );
  });

  it('does not expose non-ready or unknown videos and validates UUIDs', async () => {
    const processing = await seedReadyVideo(VideoStatus.PROCESSING);
    await request(app.getHttpServer())
      .get(`/videos/${processing.id}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/videos/${processing.id}/stream`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/videos/${randomUUID()}`)
      .expect(404);
    await request(app.getHttpServer()).get('/videos/not-a-uuid').expect(400);
  });

  it('limits anonymous public lookups to 120 requests per minute', async () => {
    const video = await seedReadyVideo();
    for (let count = 0; count < 120; count += 1) {
      await request(app.getHttpServer()).get(`/videos/${video.id}`).expect(200);
    }

    await request(app.getHttpServer()).get(`/videos/${video.id}`).expect(429);
  });
});
