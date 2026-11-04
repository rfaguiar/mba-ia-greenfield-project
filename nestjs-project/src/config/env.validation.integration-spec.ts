import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ACCESS_KEY_ID: 'access-key',
  STORAGE_SECRET_ACCESS_KEY: 'secret-key',
  RABBITMQ_URL: 'amqp://user:pass@rabbitmq:5672',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  describe('envValidationSchema — video infrastructure', () => {
    it.each([
      'STORAGE_ACCESS_KEY_ID',
      'STORAGE_SECRET_ACCESS_KEY',
      'RABBITMQ_URL',
    ])('requires %s', (key) => {
      const { error } = envValidationSchema.validate(
        Object.fromEntries(
          Object.entries(requiredEnv).filter(([envKey]) => envKey !== key),
        ),
        { allowUnknown: true, abortEarly: false },
      );
      expect(error?.message).toContain(key);
    });

    it('rejects multipart sizes below the S3 minimum', () => {
      const { error } = validate({ STORAGE_PART_SIZE_BYTES: '1048576' });
      expect(error?.message).toContain('STORAGE_PART_SIZE_BYTES');
    });

    it('rejects an upload limit larger than 10000 parts', () => {
      const { error } = validate({
        STORAGE_PART_SIZE_BYTES: '5242880',
        STORAGE_MAX_UPLOAD_BYTES: '52428800001',
      });
      expect(error).toBeDefined();
    });

    it('applies documented defaults', () => {
      const { value, error } = validate({});
      expect(error).toBeUndefined();
      expect(value.STORAGE_ENDPOINT).toBe('http://minio:9000');
      expect(value.STORAGE_PUBLIC_ENDPOINT).toBe('http://localhost:9000');
      expect(value.STORAGE_PART_SIZE_BYTES).toBe(67108864);
      expect(value.QUEUE_MAX_ATTEMPTS).toBe(3);
      expect(value.WORKER_SCRATCH_DIR).toBe('/tmp/streamtube-worker');
      expect(value.VIDEO_DRAFT_TTL_HOURS).toBe(24);
    });
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});
