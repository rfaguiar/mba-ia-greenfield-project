import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { ChannelNotFoundException } from '../../common/exceptions/domain.exception';
import { ChannelsService } from '../channels.service';

interface AuthenticatedRequest {
  params: { channelId?: string };
  user: { sub: string };
}

@Injectable()
export class ChannelOwnerGuard implements CanActivate {
  constructor(private readonly channelsService: ChannelsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const channelId = request.params.channelId;
    if (!channelId || !isUUID(channelId)) {
      throw new ChannelNotFoundException();
    }

    await this.channelsService.assertOwnership(channelId, request.user.sub);
    return true;
  }
}
