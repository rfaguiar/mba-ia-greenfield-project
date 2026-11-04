import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  StorageUnavailableException,
  UploadIncompleteException,
  UploadSizeMismatchException,
  UploadTooLargeException,
  VideoInvalidStateException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import storageConfig from '../config/storage.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import type { VideoProcessingQueue } from '../queue/video-processing.queue';
import { StorageService, UploadedPart } from '../storage/storage.service';
import { originalKey } from '../storage/storage-keys';
import {
  CompleteUploadDto,
  CreateVideoDto,
  CreatedVideoDto,
  UploadPartsDto,
} from './dto/create-video.dto';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';

@Injectable()
export class VideoUploadsService {
  private readonly logger = new Logger(VideoUploadsService.name);

  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
    @Inject(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
  ) {}

  async start(
    channelId: string,
    dto: CreateVideoDto,
  ): Promise<CreatedVideoDto> {
    if (dto.size_bytes > this.storageSettings.maxUploadBytes) {
      throw new UploadTooLargeException();
    }

    const video = await this.lifecycle.createDraft({
      channelId,
      title: dto.title,
      originalFilename: dto.original_filename,
      contentType: dto.content_type,
      sizeBytes: dto.size_bytes,
    });
    const key = originalKey(channelId, video.id, dto.content_type);
    let uploadId: string | undefined;

    try {
      uploadId = await this.storage.createMultipartUpload(
        key,
        dto.content_type,
      );
      if (!(await this.lifecycle.attachUploadId(video.id, uploadId))) {
        throw new StorageUnavailableException();
      }
      const partCount = Math.ceil(
        dto.size_bytes / this.storageSettings.partSizeBytes,
      );
      const signed = await this.storage.presignUploadParts(
        key,
        uploadId,
        range(1, partCount),
      );
      return {
        id: video.id,
        title: video.title,
        status: 'draft',
        created_at: video.created_at,
        upload: {
          upload_id: uploadId,
          part_size_bytes: this.storageSettings.partSizeBytes,
          part_count: partCount,
          expires_at: signed.expiresAt,
          parts: signed.parts.map(({ partNumber, url }) => ({
            part_number: partNumber,
            url,
          })),
        },
      };
    } catch (error) {
      await this.lifecycle.failDraft(video.id, 'STORAGE_UNAVAILABLE');
      if (uploadId) {
        try {
          await this.storage.abortMultipartUpload(key, uploadId);
        } catch (abortError) {
          this.logger.warn(
            `Could not abort failed upload initialization for video ${video.id}: ${String(abortError)}`,
          );
        }
      }
      if (error instanceof StorageUnavailableException) throw error;
      throw new StorageUnavailableException();
    }
  }

  async resume(channelId: string, videoId: string): Promise<UploadPartsDto> {
    const video = await this.getOwned(channelId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoInvalidStateException();
    }

    const key = originalKey(channelId, video.id, video.content_type);
    let uploadedParts: UploadedPart[];
    let completedObjectExists = false;
    try {
      uploadedParts = await this.storage.listUploadedParts(
        key,
        video.upload_id,
      );
    } catch (error) {
      if (!isNoSuchUpload(error)) throw error;
      const object = await this.storage.headObject(
        this.storageSettings.bucketVideos,
        key,
      );
      if (object) {
        uploadedParts = [];
        completedObjectExists = true;
      } else {
        await this.lifecycle.failDraft(video.id, 'UPLOAD_EXPIRED');
        throw new VideoInvalidStateException();
      }
    }

    const partCount = Math.ceil(
      video.size_bytes / this.storageSettings.partSizeBytes,
    );
    const uploadedNumbers = new Set(
      uploadedParts.map((part) => part.partNumber),
    );
    const missing = completedObjectExists
      ? []
      : range(1, partCount).filter(
          (partNumber) => !uploadedNumbers.has(partNumber),
        );
    const signed =
      missing.length > 0
        ? await this.storage.presignUploadParts(key, video.upload_id, missing)
        : {
            expiresAt: new Date(
              Date.now() + this.storageSettings.presignExpirySeconds * 1000,
            ),
            parts: [],
          };

    return {
      upload_id: video.upload_id,
      part_size_bytes: this.storageSettings.partSizeBytes,
      part_count: partCount,
      expires_at: signed.expiresAt,
      uploaded_parts: uploadedParts.map(({ partNumber, size }) => ({
        part_number: partNumber,
        size,
      })),
      parts: signed.parts.map(({ partNumber, url }) => ({
        part_number: partNumber,
        url,
      })),
    };
  }

  async abort(channelId: string, videoId: string): Promise<void> {
    const video = await this.getOwned(channelId, videoId);
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoInvalidStateException();
    }
    if (!(await this.lifecycle.failDraft(video.id, 'UPLOAD_ABORTED'))) {
      throw new VideoInvalidStateException();
    }
    try {
      await this.storage.abortMultipartUpload(
        originalKey(channelId, video.id, video.content_type),
        video.upload_id,
      );
    } catch (error) {
      this.logger.warn(
        `Could not abort terminal upload ${video.id}; storage expiration will reclaim it: ${String(error)}`,
      );
    }
  }

  async complete(
    channelId: string,
    videoId: string,
  ): Promise<CompleteUploadDto> {
    let video = await this.getOwned(channelId, videoId);
    if (video.status === VideoStatus.PROCESSING) {
      await this.processingQueue.requestProcessing(
        video.id,
        Math.max(1, video.processing_attempts + 1),
      );
      return { id: video.id, status: 'processing' };
    }
    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new VideoInvalidStateException();
    }

    const key = originalKey(channelId, video.id, video.content_type);
    let completed = false;
    try {
      const parts = await this.storage.listUploadedParts(key, video.upload_id);
      this.assertCompleteParts(video, parts);
      await this.storage.completeMultipartUpload(key, video.upload_id, parts);
      completed = true;
    } catch (error) {
      if (!isNoSuchUpload(error)) throw error;
    }

    const storedObject = await this.storage.headObject(
      this.storageSettings.bucketVideos,
      key,
    );
    if (!storedObject) {
      await this.lifecycle.failDraft(video.id, 'UPLOAD_EXPIRED');
      throw new VideoInvalidStateException();
    }
    if (storedObject.contentLength !== video.size_bytes) {
      await this.lifecycle.failDraft(video.id, 'UPLOAD_SIZE_MISMATCH');
      await this.storage.deleteObject(this.storageSettings.bucketVideos, key);
      throw new UploadSizeMismatchException();
    }
    if (!completed) {
      // The upload was already completed before a retry; the verified object is authoritative.
      this.logger.debug(
        `Recovered completed multipart upload for video ${video.id}`,
      );
    }

    if (!(await this.lifecycle.startProcessing(video.id))) {
      video = await this.getOwned(channelId, videoId);
      if (video.status !== VideoStatus.PROCESSING) {
        throw new VideoInvalidStateException();
      }
    }

    await this.processingQueue.requestProcessing(
      video.id,
      Math.max(1, video.processing_attempts + 1),
    );
    return { id: video.id, status: 'processing' };
  }

  private async getOwned(channelId: string, videoId: string): Promise<Video> {
    const video = await this.lifecycle.findOwned(channelId, videoId);
    if (!video) throw new VideoNotFoundException();
    return video;
  }

  private assertCompleteParts(video: Video, parts: UploadedPart[]): void {
    const partCount = Math.ceil(
      video.size_bytes / this.storageSettings.partSizeBytes,
    );
    const byNumber = new Map(parts.map((part) => [part.partNumber, part]));
    for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
      if (!byNumber.has(partNumber)) throw new UploadIncompleteException();
    }

    const ordered = range(1, partCount).map(
      (partNumber) => byNumber.get(partNumber)!,
    );
    const hasIncorrectNonFinalPart = ordered
      .slice(0, -1)
      .some((part) => part.size !== this.storageSettings.partSizeBytes);
    const uploadedSize = ordered.reduce((total, part) => total + part.size, 0);
    if (
      hasIncorrectNonFinalPart ||
      uploadedSize !== video.size_bytes ||
      ordered.at(-1)!.size > this.storageSettings.partSizeBytes
    ) {
      throw new UploadSizeMismatchException();
    }
  }
}

function range(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function isNoSuchUpload(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === 'NoSuchUpload'
  );
}
