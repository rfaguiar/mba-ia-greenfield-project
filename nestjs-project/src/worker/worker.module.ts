import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import workerConfig from '../config/worker.config';
import { envValidationSchema } from '../config/env.validation';
import { typeOrmOptionsFactory } from '../database/typeorm-options.factory';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { VideoPersistenceModule } from '../videos/video-persistence.module';
import { MediaModule } from './media/media.module';
import { VideoProcessingConsumer } from './video-processing.consumer';
import { VideoSweeperService } from './video-sweeper.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig, workerConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (config: ConfigType<typeof databaseConfig>) =>
        typeOrmOptionsFactory(config),
    }),
    VideoPersistenceModule,
    StorageModule,
    QueueModule,
    MediaModule,
  ],
  providers: [VideoProcessingConsumer, VideoSweeperService],
})
export class WorkerModule {}
