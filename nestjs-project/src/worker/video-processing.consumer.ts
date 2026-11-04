import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Nack, RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { isUUID } from 'class-validator';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import workerConfig from '../config/worker.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import type { VideoProcessingQueue } from '../queue/video-processing.queue';
import {
  VIDEO_PROCESSING_EXCHANGE,
  VIDEO_PROCESSING_QUEUE_NAME,
  VIDEO_PROCESSING_ROUTING_KEY,
  VIDEO_PROCESSING_SUBSCRIPTION_OPTIONS,
} from '../queue/video-processing.topology';
import { StorageService } from '../storage/storage.service';
import { originalKey, thumbnailKey } from '../storage/storage-keys';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import {
  PermanentProcessingError,
  TransientProcessingError,
} from './processing.errors';
import { MediaProbeService } from './media/media-probe.service';
import { ThumbnailService } from './media/thumbnail.service';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

interface ProcessingMessage {
  videoId?: unknown;
}

interface InFlightJob {
  videoId: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
}

@Injectable()
export class VideoProcessingConsumer implements BeforeApplicationShutdown {
  private readonly logger = new Logger(VideoProcessingConsumer.name);
  private activeJob: InFlightJob | null = null;
  private shuttingDown = false;

  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
    private readonly probe: MediaProbeService,
    private readonly thumbnail: ThumbnailService,
    @Inject(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
    @Inject(workerConfig.KEY)
    private readonly workerSettings: ConfigType<typeof workerConfig>,
    @Inject(queueConfig.KEY)
    private readonly queueSettings: ConfigType<typeof queueConfig>,
  ) {}

  @RabbitSubscribe({
    exchange: VIDEO_PROCESSING_EXCHANGE,
    routingKey: VIDEO_PROCESSING_ROUTING_KEY,
    queue: VIDEO_PROCESSING_QUEUE_NAME,
    queueOptions: VIDEO_PROCESSING_SUBSCRIPTION_OPTIONS,
  })
  async handle(message: ProcessingMessage): Promise<void | Nack> {
    if (typeof message?.videoId !== 'string' || !isUUID(message.videoId)) {
      return new Nack(false);
    }

    const videoId = message.videoId;
    const startedAt = Date.now();
    const claimed = await this.lifecycle.claim(
      videoId,
      this.queueSettings.consumerTimeoutMs,
    );
    if (!claimed) return;

    const controller = new AbortController();
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: InFlightJob = { videoId, controller, done, finish };
    this.activeJob = job;
    const scratchDir = join(this.workerSettings.scratchDir, videoId);
    const originalPath = join(scratchDir, 'original');
    const thumbnailPath = join(scratchDir, 'thumbnail.jpg');

    try {
      await mkdir(scratchDir, { recursive: true });
      await this.storage.downloadToFile(
        this.storageSettings.bucketVideos,
        originalKey(claimed.channel_id, claimed.id, claimed.content_type),
        originalPath,
        controller.signal,
      );
      const result = await this.probe.probe(originalPath, controller.signal);
      await this.thumbnail.render(
        originalPath,
        result.durationSeconds,
        thumbnailPath,
        controller.signal,
      );
      await this.storage.uploadFile(
        this.storageSettings.bucketThumbnails,
        thumbnailKey(claimed.channel_id, claimed.id),
        thumbnailPath,
        'image/jpeg',
      );
      const markedReady = await this.lifecycle.markReady(claimed.id, result);
      if (!markedReady) {
        this.logger.warn(
          `videoId=${videoId} attempt=${claimed.processing_attempts} outcome=state-changed elapsedMs=${Date.now() - startedAt}`,
        );
        return;
      }
      this.logger.log(
        `videoId=${videoId} attempt=${claimed.processing_attempts} outcome=ready elapsedMs=${Date.now() - startedAt}`,
      );
    } catch (error) {
      if (this.shuttingDown || controller.signal.aborted) {
        await this.lifecycle.releaseClaim(videoId);
        this.logger.log(
          `videoId=${videoId} attempt=${claimed.processing_attempts} outcome=requeued-on-shutdown elapsedMs=${Date.now() - startedAt}`,
        );
        return new Nack(true);
      }

      if (error instanceof PermanentProcessingError) {
        await this.lifecycle.failProcessing(videoId, error.code);
        this.logger.warn(
          `videoId=${videoId} attempt=${claimed.processing_attempts} outcome=${error.code} elapsedMs=${Date.now() - startedAt}`,
        );
        return;
      }

      if (claimed.processing_attempts < this.queueSettings.maxAttempts) {
        const released = await this.lifecycle.releaseClaim(videoId);
        if (!released) return;
        try {
          await this.processingQueue.scheduleRetry(
            videoId,
            claimed.processing_attempts + 1,
          );
          this.logger.warn(
            `videoId=${videoId} attempt=${claimed.processing_attempts} outcome=retry-scheduled elapsedMs=${Date.now() - startedAt}`,
          );
          return;
        } catch (queueError) {
          this.logger.error(
            `videoId=${videoId} retry publish failed: ${String(queueError)}`,
          );
          return new Nack(true);
        }
      }

      await this.lifecycle.failProcessing(videoId, 'PROCESSING_FAILED');
      this.logger.error(
        `videoId=${videoId} attempt=${claimed.processing_attempts} outcome=PROCESSING_FAILED elapsedMs=${Date.now() - startedAt}; cause=${safeError(error)}`,
      );
    } finally {
      try {
        await rm(scratchDir, { recursive: true, force: true });
      } catch (error) {
        this.logger.warn(
          `videoId=${videoId} scratch cleanup failed: ${String(error)}`,
        );
      }
      if (this.activeJob === job) this.activeJob = null;
      finish();
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (!this.activeJob) return;
    this.activeJob.controller.abort();
    await this.activeJob.done;
  }
}

function safeError(error: unknown): string {
  if (error instanceof TransientProcessingError) return error.message;
  if (error instanceof Error) return error.name;
  return 'Unknown processing error';
}
