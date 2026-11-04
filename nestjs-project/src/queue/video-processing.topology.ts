import type {
  RabbitMQExchangeConfig,
  RabbitMQQueueConfig,
} from '@golevelup/nestjs-rabbitmq';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

export const VIDEO_PROCESSING_EXCHANGE = 'video.processing';
export const VIDEO_PROCESSING_ROUTING_KEY = 'video.processing.requested';
export const VIDEO_PROCESSING_QUEUE_NAME = 'video.processing';
export const VIDEO_PROCESSING_DLX = 'video.processing.dlx';
export const VIDEO_PROCESSING_DLQ = 'video.processing.dlq';
export const VIDEO_PROCESSING_RETRY_QUEUE = 'video.processing.retry';

export function buildVideoProcessingTopology(
  config: ConfigType<typeof queueConfig>,
): {
  exchanges: RabbitMQExchangeConfig[];
  queues: RabbitMQQueueConfig[];
} {
  return {
    exchanges: [
      {
        name: VIDEO_PROCESSING_EXCHANGE,
        type: 'direct',
        options: { durable: true },
      },
      {
        name: VIDEO_PROCESSING_DLX,
        type: 'fanout',
        options: { durable: true },
      },
    ],
    queues: [
      {
        name: VIDEO_PROCESSING_QUEUE_NAME,
        exchange: VIDEO_PROCESSING_EXCHANGE,
        routingKey: VIDEO_PROCESSING_ROUTING_KEY,
        options: {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-delivery-limit': config.deliveryLimit,
            'x-dead-letter-exchange': VIDEO_PROCESSING_DLX,
            'x-consumer-timeout': config.consumerTimeoutMs,
          },
        },
      },
      {
        name: VIDEO_PROCESSING_DLQ,
        exchange: VIDEO_PROCESSING_DLX,
        routingKey: '',
        options: {
          durable: true,
          arguments: { 'x-queue-type': 'quorum' },
        },
      },
      {
        name: VIDEO_PROCESSING_RETRY_QUEUE,
        options: {
          durable: true,
          arguments: {
            'x-queue-type': 'quorum',
            'x-message-ttl': config.retryDelayMs,
            'x-dead-letter-exchange': VIDEO_PROCESSING_EXCHANGE,
            'x-dead-letter-routing-key': VIDEO_PROCESSING_ROUTING_KEY,
          },
        },
      },
    ],
  };
}

export const VIDEO_PROCESSING_SUBSCRIPTION_OPTIONS = {
  durable: true,
  arguments: {
    'x-queue-type': 'quorum',
    'x-delivery-limit': Number(process.env.QUEUE_DELIVERY_LIMIT || 3),
    'x-dead-letter-exchange': VIDEO_PROCESSING_DLX,
    'x-consumer-timeout': Number(
      process.env.QUEUE_CONSUMER_TIMEOUT_MS || 7200000,
    ),
  },
} as const;
