import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { App } from 'supertest/types';
import request from 'supertest';
import { originalKey } from '../src/storage/storage-keys';
import {
  VideoE2eContext,
  VideoE2eOwner,
  closeVideoE2eContext,
  createVideoE2eContext,
  createVideoE2eOwner,
  resetVideoE2eState,
  videoAuthHeaders,
} from './video-e2e.helpers';

interface CreatedUpload {
  id: string;
  status: string;
  upload: {
    upload_id: string;
    part_size_bytes: number;
    part_count: number;
    parts: Array<{ part_number: number; url: string }>;
  };
}

describe('Video upload routes (e2e)', () => {
  jest.setTimeout(60000);

  let context: VideoE2eContext;
  let app: INestApplication<App>;
  let owner: VideoE2eOwner;
  let foreignOwner: VideoE2eOwner;
  const uploads: Array<{
    channelId: string;
    videoId: string;
    uploadId: string;
  }> = [];
  const videoBucket = process.env.STORAGE_BUCKET_VIDEOS ?? 'videos';

  beforeAll(async () => {
    context = await createVideoE2eContext();
    app = context.app;
  });

  afterAll(async () => {
    await closeVideoE2eContext(context);
  });

  afterEach(async () => {
    for (const upload of uploads.splice(0)) {
      const key = originalKey(upload.channelId, upload.videoId, 'video/mp4');
      try {
        await context.storage.abortMultipartUpload(key, upload.uploadId);
      } catch {
        // A completed multipart upload no longer has an upload id.
      }
      try {
        await context.storage.deleteObject(videoBucket, key);
      } catch {
        // The object may not exist when completion was rejected.
      }
    }
  });

  beforeEach(async () => {
    await resetVideoE2eState(context);
    owner = await createVideoE2eOwner(
      app,
      `video-owner-${randomUUID()}@example.com`,
    );
  });

  async function startUpload(
    sizeBytes: number,
    channelId = owner.channelId,
    accessToken = owner.accessToken,
  ): Promise<CreatedUpload> {
    const response = await request(app.getHttpServer())
      .post(`/channels/${channelId}/videos`)
      .set(videoAuthHeaders(accessToken))
      .send({
        title: 'E2E sample',
        original_filename: '../../untrusted-name.mp4',
        content_type: 'video/mp4',
        size_bytes: sizeBytes,
      })
      .expect(201);
    const created = response.body as CreatedUpload;
    uploads.push({
      channelId,
      videoId: created.id,
      uploadId: created.upload.upload_id,
    });
    return created;
  }

  async function uploadPart(
    upload: CreatedUpload,
    partNumber: number,
    body: Buffer,
  ): Promise<void> {
    const part = upload.upload.parts.find(
      (item) => item.part_number === partNumber,
    );
    if (!part) throw new Error(`Missing presigned part ${partNumber}`);
    const response = await fetch(part.url, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { Origin: 'http://localhost:3001' },
      signal: AbortSignal.timeout(10000),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBeTruthy();
    expect(response.headers.get('access-control-expose-headers')).toContain(
      'ETag',
    );
  }

  it('starts a draft with deterministic presigned multipart URLs', async () => {
    const created = await startUpload(10 * 1024 * 1024 * 1024);

    expect(created.status).toBe('draft');
    expect(created.upload.part_count).toBe(
      Math.ceil((10 * 1024 * 1024 * 1024) / created.upload.part_size_bytes),
    );
    expect(created.upload.parts).toHaveLength(created.upload.part_count);
    expect(created.upload.parts[0].part_number).toBe(1);
    expect(created.upload.parts.at(-1)?.part_number).toBe(
      created.upload.part_count,
    );
    const firstUrl = new URL(created.upload.parts[0].url);
    expect(firstUrl.pathname).toBe(
      `/videos/${owner.channelId}/${created.id}/original.mp4`,
    );
    expect(firstUrl.searchParams.get('partNumber')).toBe('1');

    const row = await context.dataSource.query(
      'SELECT status, upload_id FROM videos WHERE id = $1',
      [created.id],
    );
    expect(row[0]).toMatchObject({
      status: 'draft',
      upload_id: created.upload.upload_id,
    });
  });

  it('rejects invalid input and sizes above the configured cap without creating rows', async () => {
    await request(app.getHttpServer())
      .post(`/channels/${owner.channelId}/videos`)
      .set(videoAuthHeaders(owner.accessToken))
      .send({
        title: '',
        original_filename: 'bad.mp4',
        content_type: 'application/octet-stream',
        size_bytes: 0,
      })
      .expect(400);

    const tooLarge = await request(app.getHttpServer())
      .post(`/channels/${owner.channelId}/videos`)
      .set(videoAuthHeaders(owner.accessToken))
      .send({
        title: 'Too large',
        original_filename: 'large.mp4',
        content_type: 'video/mp4',
        size_bytes: 10 * 1024 * 1024 * 1024 + 1,
      })
      .expect(422);
    expect(tooLarge.body.error).toBe('UPLOAD_TOO_LARGE');

    const rows = await context.dataSource.query(
      'SELECT id FROM videos WHERE channel_id = $1',
      [owner.channelId],
    );
    expect(rows).toHaveLength(0);
  });

  it('records storage initialization failures as terminal errors', async () => {
    jest
      .spyOn(context.storage, 'createMultipartUpload')
      .mockRejectedValueOnce(new Error('MinIO unavailable'));

    const response = await request(app.getHttpServer())
      .post(`/channels/${owner.channelId}/videos`)
      .set(videoAuthHeaders(owner.accessToken))
      .send({
        title: 'Storage error',
        original_filename: 'video.mp4',
        content_type: 'video/mp4',
        size_bytes: 1,
      })
      .expect(503);
    expect(response.body.error).toBe('STORAGE_UNAVAILABLE');

    const rows = await context.dataSource.query(
      'SELECT status, error_code FROM videos WHERE channel_id = $1',
      [owner.channelId],
    );
    expect(rows[0]).toMatchObject({
      status: 'error',
      error_code: 'STORAGE_UNAVAILABLE',
    });
  });

  it('resumes only missing parts and lets the owner abort a draft', async () => {
    const size = 10 * 1024 * 1024 + 1;
    const created = await startUpload(size);
    const partSize = created.upload.part_size_bytes;
    await uploadPart(created, 1, Buffer.alloc(partSize, 1));
    await uploadPart(created, 2, Buffer.alloc(partSize, 2));
    const resumed = await request(app.getHttpServer())
      .get(`/channels/${owner.channelId}/videos/${created.id}/uploads/parts`)
      .set(videoAuthHeaders(owner.accessToken))
      .expect(200);
    expect(resumed.body.uploaded_parts).toEqual([
      { part_number: 1, size: partSize },
      { part_number: 2, size: partSize },
    ]);
    expect(
      resumed.body.parts.map(
        (part: { part_number: number }) => part.part_number,
      ),
    ).toEqual([3]);

    await request(app.getHttpServer())
      .post(`/channels/${owner.channelId}/videos/${created.id}/uploads/abort`)
      .set(videoAuthHeaders(owner.accessToken))
      .expect(204);
    const row = await context.dataSource.query(
      'SELECT status, error_code FROM videos WHERE id = $1',
      [created.id],
    );
    expect(row[0]).toMatchObject({
      status: 'error',
      error_code: 'UPLOAD_ABORTED',
    });
    await request(app.getHttpServer())
      .get(`/channels/${owner.channelId}/videos/${created.id}/uploads/parts`)
      .set(videoAuthHeaders(owner.accessToken))
      .expect(409);
  });

  it('limits upload resume requests to 30 per minute', async () => {
    const created = await startUpload(1);
    for (let count = 0; count < 30; count += 1) {
      await request(app.getHttpServer())
        .get(`/channels/${owner.channelId}/videos/${created.id}/uploads/parts`)
        .set(videoAuthHeaders(owner.accessToken))
        .expect(200);
    }

    await request(app.getHttpServer())
      .get(`/channels/${owner.channelId}/videos/${created.id}/uploads/parts`)
      .set(videoAuthHeaders(owner.accessToken))
      .expect(429);
  });

  it('validates uploaded parts, transitions once, and retries queue publication', async () => {
    const created = await startUpload(5 * 1024 * 1024 + 7);
    const partSize = created.upload.part_size_bytes;
    await uploadPart(created, 1, Buffer.alloc(partSize, 3));
    await uploadPart(created, 2, Buffer.alloc(7, 4));

    context.queue.failNextRequest = true;
    const failedPublish = await request(app.getHttpServer())
      .post(
        `/channels/${owner.channelId}/videos/${created.id}/uploads/complete`,
      )
      .set(videoAuthHeaders(owner.accessToken))
      .expect(503);
    expect(failedPublish.body.error).toBe('QUEUE_UNAVAILABLE');

    const stillProcessing = await context.dataSource.query(
      'SELECT status FROM videos WHERE id = $1',
      [created.id],
    );
    expect(stillProcessing[0].status).toBe('processing');

    await request(app.getHttpServer())
      .post(
        `/channels/${owner.channelId}/videos/${created.id}/uploads/complete`,
      )
      .set(videoAuthHeaders(owner.accessToken))
      .expect(202);
    await request(app.getHttpServer())
      .post(
        `/channels/${owner.channelId}/videos/${created.id}/uploads/complete`,
      )
      .set(videoAuthHeaders(owner.accessToken))
      .expect(202);
    expect(
      context.queue.requests.filter((item) => item.videoId === created.id),
    ).toHaveLength(2);
  });

  it('rejects incomplete uploads and hides videos owned by another channel', async () => {
    const created = await startUpload(1);
    const incomplete = await request(app.getHttpServer())
      .post(
        `/channels/${owner.channelId}/videos/${created.id}/uploads/complete`,
      )
      .set(videoAuthHeaders(owner.accessToken))
      .expect(409);
    expect(incomplete.body.error).toBe('UPLOAD_INCOMPLETE');

    foreignOwner = await createVideoE2eOwner(
      app,
      `video-foreign-${randomUUID()}@example.com`,
    );
    await request(app.getHttpServer())
      .get(`/channels/${foreignOwner.channelId}/videos/${created.id}`)
      .set(videoAuthHeaders(foreignOwner.accessToken))
      .expect(404);
  });
});
