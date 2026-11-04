import { Nack } from '@golevelup/nestjs-rabbitmq';
import { StorageService } from '../storage/storage.service';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingQueue } from '../queue/video-processing.queue';
import { MediaProbeService } from './media/media-probe.service';
import { ThumbnailService } from './media/thumbnail.service';
import {
  PermanentProcessingError,
  TransientProcessingError,
} from './processing.errors';
import { VideoProcessingConsumer } from './video-processing.consumer';

jest.mock('@golevelup/nestjs-rabbitmq', () => ({
  Nack: class Nack {
    constructor(public readonly requeue: boolean) {}
  },
  RabbitSubscribe: () => () => undefined,
}));

const validId = '00000000-0000-4000-8000-000000000001';

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: validId,
    channel_id: 'channel-id',
    title: 'Video',
    original_filename: 'video.mp4',
    content_type: 'video/mp4',
    size_bytes: 100,
    status: VideoStatus.PROCESSING,
    upload_id: 'upload',
    duration_seconds: null,
    metadata: null,
    error_code: null,
    error_message: null,
    processing_started_at: new Date(),
    processing_attempts: 1,
    processed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as unknown as Video['channel'],
    ...overrides,
  };
}

function createConsumer(attempts = 1) {
  const lifecycle = {
    claim: jest
      .fn()
      .mockResolvedValue(makeVideo({ processing_attempts: attempts })),
    releaseClaim: jest.fn().mockResolvedValue(true),
    markReady: jest.fn().mockResolvedValue(true),
    failProcessing: jest.fn().mockResolvedValue(true),
  };
  const storage = {
    downloadToFile: jest.fn().mockResolvedValue(undefined),
    uploadFile: jest.fn().mockResolvedValue(undefined),
  };
  const probe = {
    probe: jest.fn().mockResolvedValue({
      durationSeconds: 2,
      metadata: {
        container: 'mp4',
        codec: 'h264',
        width: 320,
        height: 240,
        fps: 25,
        bitrate: 1200,
      },
    }),
  };
  const thumbnail = { render: jest.fn().mockResolvedValue(undefined) };
  const queue = { scheduleRetry: jest.fn().mockResolvedValue(undefined) };
  const workerSettings = {
    scratchDir: 'test-worker-scratch',
    videoDraftTtlHours: 24,
  };
  const storageSettings = {
    bucketVideos: 'videos',
    bucketThumbnails: 'thumbnails',
  };
  const queueSettings = { consumerTimeoutMs: 1000, maxAttempts: 3 };
  const consumer = new VideoProcessingConsumer(
    lifecycle as unknown as VideoLifecycleService,
    storage as unknown as StorageService,
    probe as unknown as MediaProbeService,
    thumbnail as unknown as ThumbnailService,
    queue as unknown as VideoProcessingQueue,
    storageSettings as never,
    workerSettings as never,
    queueSettings as never,
  );
  return { consumer, lifecycle, storage, probe, thumbnail, queue };
}

describe('VideoProcessingConsumer', () => {
  it('dead-letters an invalid payload without requeue', async () => {
    const { consumer } = createConsumer();

    const result = await consumer.handle({ videoId: 'not-a-uuid' });

    expect(result).toBeInstanceOf(Nack);
    expect((result as Nack).requeue).toBe(false);
  });

  it('acknowledges an already claimed or terminal video', async () => {
    const { consumer, lifecycle } = createConsumer();
    lifecycle.claim.mockResolvedValue(null);

    await expect(
      consumer.handle({ videoId: validId }),
    ).resolves.toBeUndefined();
  });

  it('processes the original and marks a video ready', async () => {
    const { consumer, lifecycle, storage, probe, thumbnail } = createConsumer();

    await expect(
      consumer.handle({ videoId: validId }),
    ).resolves.toBeUndefined();
    expect(storage.downloadToFile).toHaveBeenCalledWith(
      'videos',
      `channel-id/${validId}/original.mp4`,
      expect.stringContaining('original'),
      expect.any(AbortSignal),
    );
    expect(probe.probe).toHaveBeenCalled();
    expect(thumbnail.render).toHaveBeenCalled();
    expect(lifecycle.markReady).toHaveBeenCalled();
    expect(storage.uploadFile).toHaveBeenCalledWith(
      'thumbnails',
      `channel-id/${validId}/thumbnail.jpg`,
      expect.stringContaining('thumbnail.jpg'),
      'image/jpeg',
    );
  });

  it('marks permanent media errors without scheduling retry', async () => {
    const { consumer, lifecycle, queue, probe } = createConsumer();
    probe.probe.mockRejectedValue(
      new PermanentProcessingError('INVALID_MEDIA'),
    );

    await consumer.handle({ videoId: validId });

    expect(lifecycle.failProcessing).toHaveBeenCalledWith(
      validId,
      'INVALID_MEDIA',
    );
    expect(queue.scheduleRetry).not.toHaveBeenCalled();
  });

  it('releases the claim and schedules a delayed retry for transient failures', async () => {
    const { consumer, lifecycle, queue, probe } = createConsumer(1);
    probe.probe.mockRejectedValue(new TransientProcessingError());

    await consumer.handle({ videoId: validId });

    expect(lifecycle.releaseClaim).toHaveBeenCalledWith(validId);
    expect(queue.scheduleRetry).toHaveBeenCalledWith(validId, 2);
  });
});
