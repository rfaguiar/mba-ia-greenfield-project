import { Module } from '@nestjs/common';
import {
  MessageHandlerErrorBehavior,
  RabbitMQModule,
} from '@golevelup/nestjs-rabbitmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { buildVideoProcessingTopology } from './video-processing.topology';
import { VIDEO_PROCESSING_QUEUE } from './video-processing.queue';
import { RabbitMqVideoProcessingQueue } from './rabbitmq-video-processing.queue';

@Module({
  imports: [
    RabbitMQModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        uri: config.url,
        ...buildVideoProcessingTopology(config),
        channels: { default: { prefetchCount: 1, default: true } },
        defaultPublishOptions: { persistent: true },
        defaultSubscribeErrorBehavior: MessageHandlerErrorBehavior.NACK,
        connectionInitOptions: { wait: true, timeout: 10000 },
      }),
    }),
  ],
  providers: [
    RabbitMqVideoProcessingQueue,
    {
      provide: VIDEO_PROCESSING_QUEUE,
      useExisting: RabbitMqVideoProcessingQueue,
    },
  ],
  exports: [RabbitMQModule, VIDEO_PROCESSING_QUEUE],
})
export class QueueModule {}
