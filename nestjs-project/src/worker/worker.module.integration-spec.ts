import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { connect } from 'amqplib';
import { DataSource } from 'typeorm';
import { S3_CLIENT, StorageService } from '../storage/storage.service';
import { VideoLifecycleService } from '../videos/video-lifecycle.service';
import { VIDEO_PROCESSING_QUEUE } from '../queue/video-processing.queue';
import { WorkerModule } from './worker.module';

jest.mock('@golevelup/nestjs-rabbitmq', () => {
  class MockRabbitModule {}
  return {
    MessageHandlerErrorBehavior: { NACK: 'nack' },
    Nack: class Nack {
      constructor(public readonly requeue: boolean) {}
    },
    RabbitMQModule: Object.assign(MockRabbitModule, {
      forRootAsync: () => ({ module: MockRabbitModule }),
    }),
    RabbitSubscribe: () => () => undefined,
  };
});

jest.mock('../queue/rabbitmq-video-processing.queue', () => ({
  RabbitMqVideoProcessingQueue: class {
    requestProcessing = jest.fn().mockResolvedValue(undefined);
    scheduleRetry = jest.fn().mockResolvedValue(undefined);
  },
}));

describe('WorkerModule (integration)', () => {
  it('initializes persistence, storage, and the worker module without HTTP controllers', async () => {
    const broker = await connect(
      process.env.RABBITMQ_URL ?? 'amqp://streamtube:streamtube@rabbitmq:5672',
    );
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    try {
      await module.init();
      expect(module.get(DataSource).isInitialized).toBe(true);
      expect(module.get(VideoLifecycleService)).toBeInstanceOf(
        VideoLifecycleService,
      );
      expect(module.get(StorageService)).toBeInstanceOf(StorageService);
      expect(module.get(VIDEO_PROCESSING_QUEUE)).toBeDefined();
      expect(
        Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, WorkerModule) ?? [],
      ).toEqual([]);

      const client = module.get(S3_CLIENT);
      await client.send(new HeadBucketCommand({ Bucket: 'videos' }));
      await client.send(new HeadBucketCommand({ Bucket: 'thumbnails' }));
    } finally {
      await module.close();
      await broker.close();
    }
  }, 30000);
});
