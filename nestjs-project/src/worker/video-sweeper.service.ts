import {
  BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import workerConfig from '../config/worker.config';
import { QueueUnavailableException } from '../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import type { VideoProcessingQueue } from '../queue/video-processing.queue';
import { StorageService } from '../storage/storage.service';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { originalKey } from '../storage/storage-keys';

export const SWEEP_INTERVAL_MS = 300000;
export const UNCLAIMED_GRACE_MS = 600000;

@Injectable()
export class VideoSweeperService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(VideoSweeperService.name);
  private timer: NodeJS.Timeout | undefined;
  private sweeping = false;
  private activeSweep: Promise<void> | null = null;

  constructor(
    private readonly lifecycle: VideoLifecycleService,
    private readonly storage: StorageService,
    @Inject(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: VideoProcessingQueue,
    @Inject(storageConfig.KEY)
    private readonly storageSettings: ConfigType<typeof storageConfig>,
    @Inject(workerConfig.KEY)
    private readonly workerSettings: ConfigType<typeof workerConfig>,
    @Inject(queueConfig.KEY)
    private readonly queueSettings: ConfigType<typeof queueConfig>,
  ) {}

  onApplicationBootstrap(): void {
    this.startSweep();
    this.timer = setInterval(() => this.startSweep(), SWEEP_INTERVAL_MS);
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.activeSweep;
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      await this.expireDrafts();
      await this.republishUnclaimed();
      await this.recoverExpiredLeases();
    } finally {
      this.sweeping = false;
    }
  }

  private async runSweepSafely(): Promise<void> {
    try {
      await this.sweep();
    } catch (error) {
      this.logger.error(`Video recovery sweep failed: ${String(error)}`);
    }
  }

  private startSweep(): void {
    if (this.activeSweep) return;
    this.activeSweep = this.runSweepSafely().finally(() => {
      this.activeSweep = null;
    });
  }

  private async expireDrafts(): Promise<void> {
    const drafts = await this.lifecycle.findStaleDrafts(
      this.workerSettings.videoDraftTtlHours,
    );
    for (const draft of drafts) {
      try {
        if (!(await this.lifecycle.failDraft(draft.id, 'UPLOAD_EXPIRED'))) {
          continue;
        }
        if (draft.upload_id) {
          await this.storage.abortMultipartUpload(
            originalKey(draft.channel_id, draft.id, draft.content_type),
            draft.upload_id,
          );
        }
        this.logger.log(`rule=stale-draft videoId=${draft.id} outcome=expired`);
      } catch (error) {
        this.logger.warn(
          `rule=stale-draft videoId=${draft.id} outcome=retry cause=${String(error)}`,
        );
      }
    }
  }

  private async republishUnclaimed(): Promise<void> {
    const rows =
      await this.lifecycle.findUnclaimedProcessing(UNCLAIMED_GRACE_MS);
    for (const video of rows) {
      try {
        await this.processingQueue.requestProcessing(video.id);
        await this.lifecycle.touch(video.id);
        this.logger.log(
          `rule=unclaimed videoId=${video.id} outcome=republished`,
        );
      } catch (error) {
        this.logger.warn(
          `rule=unclaimed videoId=${video.id} outcome=retry cause=${String(error)}`,
        );
        if (error instanceof QueueUnavailableException) throw error;
      }
    }
  }

  private async recoverExpiredLeases(): Promise<void> {
    const rows = await this.lifecycle.findExpiredLeases(
      this.queueSettings.consumerTimeoutMs,
    );
    for (const video of rows) {
      try {
        if (video.processing_attempts < this.queueSettings.maxAttempts) {
          await this.processingQueue.requestProcessing(
            video.id,
            video.processing_attempts + 1,
          );
          this.logger.log(
            `rule=expired-lease videoId=${video.id} outcome=republished`,
          );
        } else {
          const timedOut = await this.lifecycle.timeoutProcessing(
            video.id,
            this.queueSettings.consumerTimeoutMs,
          );
          this.logger.log(
            `rule=expired-lease videoId=${video.id} outcome=${timedOut ? 'timed-out' : 'claim-refreshed'}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `rule=expired-lease videoId=${video.id} outcome=retry cause=${String(error)}`,
        );
        if (error instanceof QueueUnavailableException) throw error;
      }
    }
  }
}
