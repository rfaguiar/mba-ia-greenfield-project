import * as Joi from 'joi';

const positiveInteger = () => Joi.number().integer().positive();

function isStorageSizeConfig(values: unknown): values is {
  STORAGE_MAX_UPLOAD_BYTES: number;
  STORAGE_PART_SIZE_BYTES: number;
} {
  if (typeof values !== 'object' || values === null) return false;
  const record = values as Record<string, unknown>;
  return (
    typeof record.STORAGE_MAX_UPLOAD_BYTES === 'number' &&
    typeof record.STORAGE_PART_SIZE_BYTES === 'number'
  );
}

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().port().default(3000),
  DB_HOST: Joi.string().default('localhost'),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().required(),
  DB_NAME: Joi.string().required(),
  JWT_SECRET: Joi.string().required(),
  JWT_REFRESH_SECRET: Joi.string().required(),
  JWT_ACCESS_EXPIRATION: Joi.string().default('15m'),
  JWT_REFRESH_EXPIRATION: Joi.string().default('7d'),
  CONFIRMATION_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  PASSWORD_RESET_TOKEN_EXPIRATION_HOURS: Joi.number().default(1),
  APP_URL: Joi.string().uri().default('http://localhost:3000'),
  MAIL_HOST: Joi.string().default('mailpit'),
  MAIL_PORT: Joi.number().default(1025),
  MAIL_FROM: Joi.string().default('"StreamTube" <noreply@streamtube.com>'),
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').default('false'),
  STORAGE_ENDPOINT: Joi.string().uri().default('http://minio:9000'),
  STORAGE_PUBLIC_ENDPOINT: Joi.string().uri().default('http://localhost:9000'),
  STORAGE_REGION: Joi.string().default('us-east-1'),
  STORAGE_ACCESS_KEY_ID: Joi.string().required(),
  STORAGE_SECRET_ACCESS_KEY: Joi.string().required(),
  STORAGE_FORCE_PATH_STYLE: Joi.boolean().default(true),
  STORAGE_BUCKET_VIDEOS: Joi.string().default('videos'),
  STORAGE_BUCKET_THUMBNAILS: Joi.string().default('thumbnails'),
  STORAGE_PRESIGN_EXPIRY_SECONDS: positiveInteger().default(3600),
  STORAGE_MAX_UPLOAD_BYTES: positiveInteger().default(10737418240),
  STORAGE_PART_SIZE_BYTES: positiveInteger()
    .min(5 * 1024 * 1024)
    .max(5 * 1024 * 1024 * 1024)
    .default(67108864),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .required(),
  QUEUE_DELIVERY_LIMIT: positiveInteger().default(3),
  QUEUE_CONSUMER_TIMEOUT_MS: positiveInteger().default(7200000),
  QUEUE_RETRY_DELAY_MS: positiveInteger().default(30000),
  QUEUE_MAX_ATTEMPTS: positiveInteger().default(3),
  WORKER_SCRATCH_DIR: Joi.string().min(1).default('/tmp/streamtube-worker'),
  VIDEO_DRAFT_TTL_HOURS: positiveInteger().default(24),
}).custom((values: unknown, helpers) => {
  if (!isStorageSizeConfig(values)) return values;
  if (
    values.STORAGE_MAX_UPLOAD_BYTES >
    values.STORAGE_PART_SIZE_BYTES * 10000
  ) {
    return helpers.error('any.invalid', {
      message:
        'STORAGE_MAX_UPLOAD_BYTES must not exceed STORAGE_PART_SIZE_BYTES × 10000',
    });
  }

  return values;
});
