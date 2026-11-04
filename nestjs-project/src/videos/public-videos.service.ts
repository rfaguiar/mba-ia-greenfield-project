import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import { originalKey, thumbnailKey } from '../storage/storage-keys';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { PublicVideoDto, PresignedUrlDto } from './dto/public-video.dto';
import { VideoLifecycleService } from './video-lifecycle.service';
import { attachmentDisposition } from './content-disposition.util';

@Injectable()
export class PublicVideosService {
  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {}

  async metadata(videoId: string): Promise<PublicVideoDto> {
    const video = await this.readyVideo(videoId);
    if (
      video.duration_seconds === null ||
      !video.metadata ||
      !video.processed_at
    ) {
      throw new VideoNotFoundException();
    }
    return {
      id: video.id,
      channel_id: video.channel_id,
      title: video.title,
      content_type: video.content_type,
      size_bytes: video.size_bytes,
      duration_seconds: video.duration_seconds,
      metadata: video.metadata,
      created_at: video.created_at,
      processed_at: video.processed_at,
    };
  }

  async stream(videoId: string): Promise<PresignedUrlDto> {
    const video = await this.readyVideo(videoId);
    const signed = await this.storage.presignGetObject(
      this.config.bucketVideos,
      originalKey(video.channel_id, video.id, video.content_type),
    );
    return { url: signed.url, expires_at: signed.expiresAt };
  }

  async download(videoId: string): Promise<PresignedUrlDto> {
    const video = await this.readyVideo(videoId);
    const signed = await this.storage.presignGetObject(
      this.config.bucketVideos,
      originalKey(video.channel_id, video.id, video.content_type),
      attachmentDisposition(video.original_filename),
    );
    return { url: signed.url, expires_at: signed.expiresAt };
  }

  async thumbnail(videoId: string): Promise<PresignedUrlDto> {
    const video = await this.readyVideo(videoId);
    const signed = await this.storage.presignGetObject(
      this.config.bucketThumbnails,
      thumbnailKey(video.channel_id, video.id),
    );
    return { url: signed.url, expires_at: signed.expiresAt };
  }

  private async readyVideo(videoId: string) {
    const video = await this.lifecycle.findReady(videoId);
    if (!video) throw new VideoNotFoundException();
    return video;
  }
}
