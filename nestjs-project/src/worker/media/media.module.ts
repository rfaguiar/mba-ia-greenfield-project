import { Module } from '@nestjs/common';
import { MediaProbeService } from './media-probe.service';
import { ThumbnailService } from './thumbnail.service';

@Module({
  providers: [MediaProbeService, ThumbnailService],
  exports: [MediaProbeService, ThumbnailService],
})
export class MediaModule {}
