import type { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { QueueUnavailableException } from '../common/exceptions/domain.exception';
import { RabbitMqVideoProcessingQueue } from './rabbitmq-video-processing.queue';

jest.mock('@golevelup/nestjs-rabbitmq', () => ({
  AmqpConnection: class AmqpConnection {},
}));

describe('RabbitMqVideoProcessingQueue', () => {
  it('publishes persistent messages with stable ids and attempt headers', async () => {
    const amqp = { publish: jest.fn().mockResolvedValue(true) };
    const queue = new RabbitMqVideoProcessingQueue(
      amqp as unknown as AmqpConnection,
    );

    await queue.requestProcessing('video-id', 2);

    expect(amqp.publish).toHaveBeenCalledWith(
      'video.processing',
      'video.processing.requested',
      { videoId: 'video-id' },
      expect.objectContaining({
        messageId: 'video-id',
        persistent: true,
        contentType: 'application/json',
        headers: { 'x-attempt': 2 },
      }),
    );
  });

  it('surfaces a bounded queue timeout', async () => {
    jest.useFakeTimers();
    const amqp = { publish: jest.fn().mockReturnValue(new Promise(() => {})) };
    const queue = new RabbitMqVideoProcessingQueue(
      amqp as unknown as AmqpConnection,
    );
    const request = expect(
      queue.requestProcessing('video-id'),
    ).rejects.toBeInstanceOf(QueueUnavailableException);

    await jest.advanceTimersByTimeAsync(5000);
    await request;
    jest.useRealTimers();
  });
});
