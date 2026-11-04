import {
  StorageUnavailableException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  UploadTooLargeException,
  VideoInvalidStateException,
} from '../common/exceptions/domain.exception';
import { VideoProcessingQueue } from '../queue/video-processing.queue';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { CreateVideoDto } from './dto/create-video.dto';
import { VideoLifecycleService } from './video-lifecycle.service';
import { VideoUploadsService } from './video-uploads.service';

const storageSettings = {
  endpoint: 'http://minio:9000',
  publicEndpoint: 'http://localhost:9000',
  region: 'us-east-1',
  accessKeyId: 'access',
  secretAccessKey: 'secret',
  forcePathStyle: true,
  bucketVideos: 'videos',
  bucketThumbnails: 'thumbnails',
  presignExpirySeconds: 3600,
  maxUploadBytes: 10737418240,
  partSizeBytes: 67108864,
};

function makeVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'video-id',
    channel_id: 'channel-id',
    title: 'Video',
    original_filename: 'clip.mp4',
    content_type: 'video/mp4',
    size_bytes: 100,
    status: VideoStatus.DRAFT,
    upload_id: 'upload-id',
    duration_seconds: null,
    metadata: null,
    error_code: null,
    error_message: null,
    processing_started_at: null,
    processing_attempts: 0,
    processed_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    channel: undefined as unknown as Video['channel'],
    ...overrides,
  };
}

function createService(partSizeBytes = storageSettings.partSizeBytes) {
  const config = { ...storageSettings, partSizeBytes };
  const lifecycle = {
    createDraft: jest.fn().mockResolvedValue(makeVideo()),
    findOwned: jest.fn().mockResolvedValue(makeVideo()),
    attachUploadId: jest.fn().mockResolvedValue(true),
    failDraft: jest.fn().mockResolvedValue(true),
    startProcessing: jest.fn().mockResolvedValue(true),
  };
  const storage = {
    createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
    presignUploadParts: jest
      .fn()
      .mockImplementation(
        async (_key: string, _uploadId: string, numbers: number[]) => ({
          expiresAt: new Date(Date.now() + 3600000),
          parts: numbers.map((partNumber) => ({
            partNumber,
            url: `https://minio/${partNumber}`,
          })),
        }),
      ),
    listUploadedParts: jest
      .fn()
      .mockResolvedValue([{ partNumber: 1, etag: '"part"', size: 100 }]),
    completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    headObject: jest.fn().mockResolvedValue({ contentLength: 100 }),
    deleteObject: jest.fn().mockResolvedValue(undefined),
    abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
  };
  const queue = { requestProcessing: jest.fn().mockResolvedValue(undefined) };
  const service = new VideoUploadsService(
    lifecycle as unknown as VideoLifecycleService,
    storage as unknown as StorageService,
    queue as unknown as VideoProcessingQueue,
    config,
  );
  const dto: CreateVideoDto = {
    title: 'Video',
    original_filename: '../../evil.exe',
    content_type: 'video/mp4',
    size_bytes: 100,
  };
  return { service, lifecycle, storage, queue, dto };
}

describe('VideoUploadsService', () => {
  it('rejects oversized uploads before creating a draft', async () => {
    const { service, lifecycle, dto } = createService();
    dto.size_bytes = storageSettings.maxUploadBytes + 1;

    await expect(service.start('channel-id', dto)).rejects.toBeInstanceOf(
      UploadTooLargeException,
    );
    expect(lifecycle.createDraft).not.toHaveBeenCalled();
  });

  it.each([
    [1, 1],
    [67108864, 1],
    [10737418240, 160],
  ])('creates %i-byte uploads with %i part URLs', async (size, partCount) => {
    const { service, dto } = createService();
    dto.size_bytes = size;

    const result = await service.start('channel-id', dto);

    expect(result.upload.part_count).toBe(partCount);
    expect(result.upload.parts).toHaveLength(partCount);
    expect(result.upload.parts[0].part_number).toBe(1);
    expect(result.upload.parts.at(-1)?.part_number).toBe(partCount);
  });

  it('moves an initialized draft to error when storage initialization fails', async () => {
    const { service, lifecycle, storage, dto } = createService();
    storage.createMultipartUpload.mockRejectedValue(
      new StorageUnavailableException(),
    );

    await expect(service.start('channel-id', dto)).rejects.toBeInstanceOf(
      StorageUnavailableException,
    );
    expect(lifecycle.failDraft).toHaveBeenCalledWith(
      'video-id',
      'STORAGE_UNAVAILABLE',
    );
  });

  it('re-signs only missing parts for resume', async () => {
    const { service, storage } = createService(50);
    storage.listUploadedParts.mockResolvedValue([
      { partNumber: 1, etag: '"one"', size: 50 },
    ]);

    const result = await service.resume('channel-id', 'video-id');

    expect(result.uploaded_parts).toEqual([{ part_number: 1, size: 50 }]);
    expect(storage.presignUploadParts).toHaveBeenCalledWith(
      'channel-id/video-id/original.mp4',
      'upload-id',
      [2],
    );
    expect(result.parts).toEqual([{ part_number: 2, url: 'https://minio/2' }]);
  });

  it('rejects resume for a video outside draft state', async () => {
    const { service, lifecycle } = createService();
    lifecycle.findOwned.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING }),
    );

    await expect(
      service.resume('channel-id', 'video-id'),
    ).rejects.toBeInstanceOf(VideoInvalidStateException);
  });

  it('marks abort terminal before aborting storage', async () => {
    const { service, lifecycle, storage } = createService();

    await service.abort('channel-id', 'video-id');

    expect(lifecycle.failDraft.mock.invocationCallOrder[0]).toBeLessThan(
      storage.abortMultipartUpload.mock.invocationCallOrder[0],
    );
  });

  it('leaves incomplete uploads resumable', async () => {
    const { service, lifecycle, storage } = createService();
    storage.listUploadedParts.mockResolvedValue([]);

    await expect(
      service.complete('channel-id', 'video-id'),
    ).rejects.toBeInstanceOf(UploadIncompleteException);
    expect(lifecycle.startProcessing).not.toHaveBeenCalled();
  });

  it('verifies storage size and enqueues after the state transition', async () => {
    const { service, lifecycle, storage, queue } = createService();

    await expect(service.complete('channel-id', 'video-id')).resolves.toEqual({
      id: 'video-id',
      status: 'processing',
    });
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      'channel-id/video-id/original.mp4',
      'upload-id',
      [{ partNumber: 1, etag: '"part"', size: 100 }],
    );
    expect(lifecycle.startProcessing.mock.invocationCallOrder[0]).toBeLessThan(
      queue.requestProcessing.mock.invocationCallOrder[0],
    );
  });

  it('rejects a completed object whose size differs from the declared size', async () => {
    const { service, storage, lifecycle } = createService();
    storage.headObject.mockResolvedValue({ contentLength: 99 });

    await expect(
      service.complete('channel-id', 'video-id'),
    ).rejects.toBeInstanceOf(UploadSizeMismatchException);
    expect(storage.deleteObject).toHaveBeenCalledWith(
      'videos',
      'channel-id/video-id/original.mp4',
    );
    expect(lifecycle.failDraft).toHaveBeenCalledWith(
      'video-id',
      'UPLOAD_SIZE_MISMATCH',
    );
  });

  it('re-publishes processing videos on an idempotent complete retry', async () => {
    const { service, lifecycle, storage, queue } = createService();
    lifecycle.findOwned.mockResolvedValue(
      makeVideo({ status: VideoStatus.PROCESSING }),
    );

    await expect(service.complete('channel-id', 'video-id')).resolves.toEqual({
      id: 'video-id',
      status: 'processing',
    });
    expect(storage.listUploadedParts).not.toHaveBeenCalled();
    expect(queue.requestProcessing).toHaveBeenCalledWith('video-id', 1);
  });
});
