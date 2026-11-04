import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { S3Client } from '@aws-sdk/client-s3';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';

import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { QueueUnavailableException } from '../src/common/exceptions/domain.exception';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/video-processing.queue';
import type { VideoProcessingQueue } from '../src/queue/video-processing.queue';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';

export class VideoQueueRecorder implements VideoProcessingQueue {
  readonly requests: Array<{ videoId: string; attempt?: number }> = [];
  readonly retries: Array<{ videoId: string; attempt: number }> = [];
  failNextRequest = false;

  requestProcessing(videoId: string, attempt?: number): Promise<void> {
    if (this.failNextRequest) {
      this.failNextRequest = false;
      throw new QueueUnavailableException();
    }
    this.requests.push({ videoId, attempt });
    return Promise.resolve();
  }

  scheduleRetry(videoId: string, attempt: number): Promise<void> {
    this.retries.push({ videoId, attempt });
    return Promise.resolve();
  }
}

export interface VideoE2eContext {
  app: INestApplication<App>;
  dataSource: DataSource;
  queue: VideoQueueRecorder;
  storage: StorageService;
  s3: S3Client;
  throttlerStorage: ThrottlerStorageService;
}

export interface VideoE2eOwner {
  accessToken: string;
  channelId: string;
}

export async function createVideoE2eContext(): Promise<VideoE2eContext> {
  process.env.STORAGE_PUBLIC_ENDPOINT = 'http://minio-cors-proxy:9000';
  process.env.STORAGE_PART_SIZE_BYTES = String(5 * 1024 * 1024);
  const queue = new VideoQueueRecorder();
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(VIDEO_PROCESSING_QUEUE)
    .useValue(queue)
    .compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();

  const s3 = new S3Client({
    region: process.env.STORAGE_REGION ?? 'us-east-1',
    endpoint: process.env.STORAGE_ENDPOINT ?? 'http://minio:9000',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.STORAGE_ACCESS_KEY_ID ?? 'streamtube',
      secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY ?? 'streamtube',
    },
  });

  return {
    app,
    dataSource: moduleFixture.get(DataSource),
    queue,
    storage: moduleFixture.get(StorageService),
    s3,
    throttlerStorage:
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage),
  };
}

export async function createVideoE2eOwner(
  app: INestApplication<App>,
  email: string,
): Promise<VideoE2eOwner> {
  const authService = app.get(AuthService);
  const mailService = (authService as any).mailService as {
    sendConfirmationEmail: (
      email: string,
      nickname: string,
      token: string,
    ) => Promise<void>;
  };
  let token = '';
  jest
    .spyOn(mailService, 'sendConfirmationEmail')
    .mockImplementationOnce((_email, _nickname, confirmationToken) => {
      token = confirmationToken;
      return Promise.resolve();
    });

  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, password: 'password123' })
    .expect(201);
  await request(app.getHttpServer())
    .get('/auth/confirm-email')
    .query({ token })
    .expect(204);
  const login = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password: 'password123' })
    .expect(200);
  const profile = await request(app.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${login.body.access_token}`)
    .expect(200);

  return {
    accessToken: login.body.access_token as string,
    channelId: profile.body.channel_id as string,
  };
}

export async function resetVideoE2eState(
  context: VideoE2eContext,
): Promise<void> {
  context.throttlerStorage.storage.clear();
  await cleanAllTables(context.dataSource);
  context.queue.requests.length = 0;
  context.queue.retries.length = 0;
  context.queue.failNextRequest = false;
}

export async function closeVideoE2eContext(
  context: VideoE2eContext,
): Promise<void> {
  context.s3.destroy();
  await context.app.close();
}

export function videoAuthHeaders(accessToken: string): {
  Authorization: string;
} {
  return { Authorization: `Bearer ${accessToken}` };
}
