import { Injectable } from '@nestjs/common';
import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { QueueUnavailableException } from '../common/exceptions/domain.exception';
import {
  VIDEO_PROCESSING_EXCHANGE,
  VIDEO_PROCESSING_RETRY_QUEUE,
  VIDEO_PROCESSING_ROUTING_KEY,
} from './video-processing.topology';
import { VideoProcessingQueue } from './video-processing.queue';

const PUBLISH_TIMEOUT_MS = 5000;

@Injectable()
export class RabbitMqVideoProcessingQueue implements VideoProcessingQueue {
  constructor(private readonly amqp: AmqpConnection) {}

  requestProcessing(videoId: string, attempt = 1): Promise<void> {
    return this.publish(
      VIDEO_PROCESSING_EXCHANGE,
      VIDEO_PROCESSING_ROUTING_KEY,
      videoId,
      attempt,
    );
  }

  scheduleRetry(videoId: string, attempt: number): Promise<void> {
    return this.publish('', VIDEO_PROCESSING_RETRY_QUEUE, videoId, attempt);
  }

  private async publish(
    exchange: string,
    routingKey: string,
    videoId: string,
    attempt: number,
  ): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.amqp.publish(
          exchange,
          routingKey,
          { videoId },
          {
            messageId: videoId,
            persistent: true,
            contentType: 'application/json',
            headers: { 'x-attempt': attempt },
          },
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('RabbitMQ publish timed out')),
            PUBLISH_TIMEOUT_MS,
          );
        }),
      ]);
    } catch {
      throw new QueueUnavailableException();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
