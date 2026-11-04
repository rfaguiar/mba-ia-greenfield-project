import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryDeepPartialEntity, Repository } from 'typeorm';
import {
  Video,
  VideoErrorCode,
  VideoMetadata,
  VideoStatus,
  VIDEO_ERROR_MESSAGES,
} from './entities/video.entity';

export interface CreateVideoDraft {
  channelId: string;
  title: string;
  originalFilename: string;
  contentType: string;
  sizeBytes: number;
}

@Injectable()
export class VideoLifecycleService {
  constructor(
    @InjectRepository(Video)
    private readonly videos: Repository<Video>,
  ) {}

  async createDraft(input: CreateVideoDraft): Promise<Video> {
    return this.videos.save(
      this.videos.create({
        channel_id: input.channelId,
        title: input.title,
        original_filename: input.originalFilename,
        content_type: input.contentType,
        size_bytes: input.sizeBytes,
        status: VideoStatus.DRAFT,
      }),
    );
  }

  findOwned(channelId: string, videoId: string): Promise<Video | null> {
    return this.videos.findOneBy({ id: videoId, channel_id: channelId });
  }

  findReady(videoId: string): Promise<Video | null> {
    return this.videos.findOneBy({ id: videoId, status: VideoStatus.READY });
  }

  attachUploadId(id: string, uploadId: string): Promise<boolean> {
    return this.transition(id, VideoStatus.DRAFT, {
      upload_id: uploadId,
    });
  }

  failDraft(id: string, errorCode: VideoErrorCode): Promise<boolean> {
    return this.transition(id, VideoStatus.DRAFT, {
      status: VideoStatus.ERROR,
      error_code: errorCode,
      error_message: VIDEO_ERROR_MESSAGES[errorCode],
    });
  }

  startProcessing(id: string): Promise<boolean> {
    return this.transition(id, VideoStatus.DRAFT, {
      status: VideoStatus.PROCESSING,
      processing_started_at: null,
      processing_attempts: 0,
    });
  }

  markReady(
    id: string,
    result: { durationSeconds: number; metadata: VideoMetadata },
  ): Promise<boolean> {
    return this.transition(id, VideoStatus.PROCESSING, {
      status: VideoStatus.READY,
      duration_seconds: result.durationSeconds,
      metadata: result.metadata,
      processed_at: () => 'NOW()',
      processing_started_at: null,
      error_code: null,
      error_message: null,
    });
  }

  failProcessing(id: string, errorCode: VideoErrorCode): Promise<boolean> {
    return this.transition(id, VideoStatus.PROCESSING, {
      status: VideoStatus.ERROR,
      error_code: errorCode,
      error_message: VIDEO_ERROR_MESSAGES[errorCode],
      processing_started_at: null,
    });
  }

  async claim(id: string, leaseMs: number): Promise<Video | null> {
    const result = await this.videos
      .createQueryBuilder()
      .update(Video)
      .set({
        processing_started_at: () => 'NOW()',
        processing_attempts: () => '"processing_attempts" + 1',
        updated_at: () => 'NOW()',
      })
      .where(
        `id = :id
         AND status = :status
         AND (processing_started_at IS NULL
           OR processing_started_at < NOW() - (:leaseMs * INTERVAL '1 millisecond'))`,
        { id, status: VideoStatus.PROCESSING, leaseMs },
      )
      .returning('*')
      .execute();
    const row = (result.raw as Partial<Video>[])[0];
    return row ? this.videos.create(row) : null;
  }

  releaseClaim(id: string): Promise<boolean> {
    return this.conditionalUpdate(
      id,
      `status = :status`,
      { status: VideoStatus.PROCESSING },
      { processing_started_at: null },
    );
  }

  async findStaleDrafts(ttlHours: number): Promise<Video[]> {
    return this.videos
      .createQueryBuilder('video')
      .where('video.status = :status', { status: VideoStatus.DRAFT })
      .andWhere("video.created_at < NOW() - (:ttlHours * INTERVAL '1 hour')", {
        ttlHours,
      })
      .orderBy('video.created_at', 'ASC')
      .take(100)
      .getMany();
  }

  async findUnclaimedProcessing(graceMs: number): Promise<Video[]> {
    return this.videos
      .createQueryBuilder('video')
      .where('video.status = :status', { status: VideoStatus.PROCESSING })
      .andWhere('video.processing_started_at IS NULL')
      .andWhere(
        "video.updated_at < NOW() - (:graceMs * INTERVAL '1 millisecond')",
        { graceMs },
      )
      .orderBy('video.updated_at', 'ASC')
      .take(100)
      .getMany();
  }

  async findExpiredLeases(leaseMs: number): Promise<Video[]> {
    return this.videos
      .createQueryBuilder('video')
      .where('video.status = :status', { status: VideoStatus.PROCESSING })
      .andWhere(
        `video.processing_started_at < NOW() - (:leaseMs * INTERVAL '1 millisecond')`,
        { leaseMs },
      )
      .orderBy('video.processing_started_at', 'ASC')
      .take(100)
      .getMany();
  }

  touch(id: string): Promise<boolean> {
    return this.conditionalUpdate(
      id,
      'status = :status AND processing_started_at IS NULL',
      { status: VideoStatus.PROCESSING },
      {},
    );
  }

  timeoutProcessing(id: string, leaseMs: number): Promise<boolean> {
    return this.conditionalUpdate(
      id,
      `status = :status
       AND processing_started_at < NOW() - (:leaseMs * INTERVAL '1 millisecond')`,
      { status: VideoStatus.PROCESSING, leaseMs },
      {
        status: VideoStatus.ERROR,
        error_code: 'PROCESSING_TIMEOUT',
        error_message: VIDEO_ERROR_MESSAGES.PROCESSING_TIMEOUT,
        processing_started_at: null,
      },
    );
  }

  private async transition(
    id: string,
    expected: VideoStatus,
    values: QueryDeepPartialEntity<Video>,
  ): Promise<boolean> {
    return this.conditionalUpdate(
      id,
      'status = :expected',
      { expected },
      values,
    );
  }

  private async conditionalUpdate(
    id: string,
    condition: string,
    parameters: Record<string, unknown>,
    values: QueryDeepPartialEntity<Video>,
  ): Promise<boolean> {
    const result = await this.videos
      .createQueryBuilder()
      .update(Video)
      .set({ ...values, updated_at: () => 'NOW()' })
      .where(`id = :id AND ${condition}`, { id, ...parameters })
      .execute();
    return result.affected === 1;
  }
}
