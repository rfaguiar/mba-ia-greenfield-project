import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  url: process.env.RABBITMQ_URL,
  deliveryLimit: Number(process.env.QUEUE_DELIVERY_LIMIT || 3),
  consumerTimeoutMs: Number(process.env.QUEUE_CONSUMER_TIMEOUT_MS || 7200000),
  retryDelayMs: Number(process.env.QUEUE_RETRY_DELAY_MS || 30000),
  maxAttempts: Number(process.env.QUEUE_MAX_ATTEMPTS || 3),
}));
