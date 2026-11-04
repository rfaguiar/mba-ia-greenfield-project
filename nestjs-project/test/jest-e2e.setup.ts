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

jest.mock('../src/queue/rabbitmq-video-processing.queue', () => ({
  RabbitMqVideoProcessingQueue: class {
    requestProcessing = jest.fn().mockResolvedValue(undefined);
    scheduleRetry = jest.fn().mockResolvedValue(undefined);
  },
}));
