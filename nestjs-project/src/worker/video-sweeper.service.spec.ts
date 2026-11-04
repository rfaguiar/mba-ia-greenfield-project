import { QueueUnavailableException } from '../common/exceptions/domain.exception';
import { StorageService } from '../storage/storage.service';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingQueue } from '../queue/video-processing.queue';
import { VideoSweeperService } from './video-sweeper.service';

function createSweeper() {
  const lifecycle = {
    findStaleDrafts: jest.fn().mockResolvedValue([]),
    findUnclaimedProcessing: jest.fn().mockResolvedValue([]),
    findExpiredLeases: jest.fn().mockResolvedValue([]),
    failDraft: jest.fn().mockResolvedValue(true),
    touch: jest.fn().mockResolvedValue(true),
    timeoutProcessing: jest.fn().mockResolvedValue(true),
  };
  const storage = {
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { requestProcessing: jest.fn().mockResolvedValue(undefined) };
  const service = new VideoSweeperService(
    lifecycle as unknown as VideoLifecycleService,
    storage as unknown as StorageService,
    queue as unknown as VideoProcessingQueue,
    {
      bucketVideos: 'videos',
      bucketThumbnails: 'thumbnails',
    } as never,
    { scratchDir: 'scratch', videoDraftTtlHours: 24 } as never,
    { consumerTimeoutMs: 1000, maxAttempts: 3 } as never,
  );
  return { service, lifecycle, storage, queue };
}

describe('VideoSweeperService', () => {
  it('fails stale drafts and aborts their multipart uploads', async () => {
    const { service, lifecycle, storage } = createSweeper();
    lifecycle.findStaleDrafts.mockResolvedValue([
      {
        id: 'video-id',
        channel_id: 'channel-id',
        content_type: 'video/mp4',
        upload_id: 'upload-id',
      } as Video,
    ]);

    await service.sweep();

    expect(lifecycle.failDraft).toHaveBeenCalledWith(
      'video-id',
      'UPLOAD_EXPIRED',
    );
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
      'channel-id/video-id/original.mp4',
      'upload-id',
    );
  });

  it('re-publishes unclaimed rows and touches them after enqueue', async () => {
    const { service, lifecycle, queue } = createSweeper();
    lifecycle.findUnclaimedProcessing.mockResolvedValue([
      { id: 'video-id' } as Video,
    ]);

    await service.sweep();

    expect(queue.requestProcessing.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.touch.mock.invocationCallOrder[0],
    );
  });

  it('times out expired leases after the attempt limit', async () => {
    const { service, lifecycle, queue } = createSweeper();
    lifecycle.findExpiredLeases.mockResolvedValue([
      {
        id: 'video-id',
        processing_attempts: 3,
        status: VideoStatus.PROCESSING,
      } as Video,
    ]);

    await service.sweep();

    expect(lifecycle.timeoutProcessing).toHaveBeenCalledWith('video-id', 1000);
    expect(queue.requestProcessing).not.toHaveBeenCalled();
  });

  it('stops the current sweep on a queue outage so the next tick can retry', async () => {
    const { service, lifecycle, queue } = createSweeper();
    lifecycle.findUnclaimedProcessing.mockResolvedValue([
      { id: 'video-id' } as Video,
    ]);
    queue.requestProcessing.mockRejectedValue(new QueueUnavailableException());

    await expect(service.sweep()).rejects.toBeInstanceOf(
      QueueUnavailableException,
    );
    expect(lifecycle.findExpiredLeases).not.toHaveBeenCalled();
  });

  it('skips overlapping sweeps', async () => {
    const { service, lifecycle } = createSweeper();
    let finish!: (rows: Video[]) => void;
    lifecycle.findStaleDrafts.mockReturnValue(
      new Promise<Video[]>((resolve) => {
        finish = resolve;
      }),
    );
    const first = service.sweep();
    await service.sweep();
    finish([]);
    await first;

    expect(lifecycle.findStaleDrafts).toHaveBeenCalledTimes(1);
  });

  it('clears its timer and waits for an active sweep during shutdown', async () => {
    jest.useFakeTimers();
    const { service, lifecycle } = createSweeper();
    let finish!: (rows: Video[]) => void;
    lifecycle.findStaleDrafts.mockReturnValue(
      new Promise<Video[]>((resolve) => {
        finish = resolve;
      }),
    );

    service.onApplicationBootstrap();
    const shutdown = service.beforeApplicationShutdown();
    let shutdownFinished = false;
    void shutdown.then(() => {
      shutdownFinished = true;
    });

    await Promise.resolve();
    expect(shutdownFinished).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    finish([]);
    await shutdown;
    expect(shutdownFinished).toBe(true);
    jest.useRealTimers();
  });
});
