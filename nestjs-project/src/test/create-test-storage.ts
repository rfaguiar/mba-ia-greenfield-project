import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';

export function createTestStorage(): {
  storage: StorageService;
  client: S3Client;
  presignClient: S3Client;
  settings: ConfigType<typeof storageConfig>;
} {
  const endpoint = process.env.STORAGE_ENDPOINT ?? 'http://minio:9000';
  const settings: ConfigType<typeof storageConfig> = {
    endpoint,
    publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT ?? 'http://minio:9000',
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
    secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube',
    forcePathStyle: true,
    bucketVideos: process.env.STORAGE_BUCKET_VIDEOS ?? 'videos',
    bucketThumbnails: process.env.STORAGE_BUCKET_THUMBNAILS ?? 'thumbnails',
    presignExpirySeconds: 300,
    maxUploadBytes: 10 * 1024 * 1024 * 1024,
    partSizeBytes: 5 * 1024 * 1024,
  };
  const client = createClient(settings, endpoint);
  const presignClient = createClient(settings, settings.publicEndpoint);

  return {
    storage: new StorageService(client, presignClient, settings),
    client,
    presignClient,
    settings,
  };
}

function createClient(
  settings: ConfigType<typeof storageConfig>,
  endpoint: string,
): S3Client {
  return new S3Client({
    region: settings.region,
    endpoint,
    forcePathStyle: settings.forcePathStyle,
    credentials: {
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}
