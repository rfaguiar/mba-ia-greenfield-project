import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { VideoPersistenceModule } from './video-persistence.module';
import { VideoUploadsService } from './video-uploads.service';
import { VideosController } from './videos.controller';
import { PublicVideosController } from './public-videos.controller';
import { PublicVideosService } from './public-videos.service';

@Module({
  imports: [VideoPersistenceModule, ChannelsModule, StorageModule, QueueModule],
  providers: [VideoUploadsService, PublicVideosService],
  controllers: [VideosController, PublicVideosController],
})
export class VideosModule {}
