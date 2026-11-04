import { buildVideoProcessingTopology } from './video-processing.topology';

describe('video processing topology', () => {
  it('declares durable quorum queues and delayed dead-letter routing', () => {
    const topology = buildVideoProcessingTopology({
      url: 'amqp://guest:guest@localhost',
      deliveryLimit: 3,
      consumerTimeoutMs: 7200000,
      retryDelayMs: 30000,
      maxAttempts: 3,
    });

    expect(topology.exchanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'video.processing', type: 'direct' }),
        expect.objectContaining({
          name: 'video.processing.dlx',
          type: 'fanout',
        }),
      ]),
    );
    const processingQueue = topology.queues.find(
      (queue) => queue.name === 'video.processing',
    );
    expect(processingQueue?.options?.arguments).toMatchObject({
      'x-queue-type': 'quorum',
      'x-delivery-limit': 3,
      'x-consumer-timeout': 7200000,
      'x-dead-letter-exchange': 'video.processing.dlx',
    });
    expect(
      topology.queues.find((queue) => queue.name === 'video.processing.retry')
        ?.options?.arguments,
    ).toMatchObject({
      'x-message-ttl': 30000,
      'x-dead-letter-exchange': 'video.processing',
      'x-dead-letter-routing-key': 'video.processing.requested',
    });
  });
});
