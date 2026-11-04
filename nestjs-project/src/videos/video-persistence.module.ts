import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideoLifecycleService } from './video-lifecycle.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video, Channel, User])],
  providers: [VideoLifecycleService],
  exports: [TypeOrmModule, VideoLifecycleService],
})
export class VideoPersistenceModule {}
