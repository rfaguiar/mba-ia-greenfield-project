import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './entities/channel.entity';
import { ChannelsService } from './channels.service';
import { ChannelOwnerGuard } from './guards/channel-owner.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Channel])],
  providers: [ChannelsService, ChannelOwnerGuard],
  exports: [TypeOrmModule, ChannelsService, ChannelOwnerGuard],
})
export class ChannelsModule {}
