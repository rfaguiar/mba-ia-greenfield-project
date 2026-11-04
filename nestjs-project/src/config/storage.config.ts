import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKeyId: process.env.STORAGE_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY || '',
  forcePathStyle:
    process.env.STORAGE_FORCE_PATH_STYLE?.toLowerCase() !== 'false',
  bucketVideos: process.env.STORAGE_BUCKET_VIDEOS || 'videos',
  bucketThumbnails: process.env.STORAGE_BUCKET_THUMBNAILS || 'thumbnails',
  presignExpirySeconds: Number(
    process.env.STORAGE_PRESIGN_EXPIRY_SECONDS || 3600,
  ),
  maxUploadBytes: Number(process.env.STORAGE_MAX_UPLOAD_BYTES || 10737418240),
  partSizeBytes: Number(process.env.STORAGE_PART_SIZE_BYTES || 67108864),
}));
