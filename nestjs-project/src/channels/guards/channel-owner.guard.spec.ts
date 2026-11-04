import { ExecutionContext } from '@nestjs/common';
import { ChannelNotFoundException } from '../../common/exceptions/domain.exception';
import { ChannelsService } from '../channels.service';
import { ChannelOwnerGuard } from './channel-owner.guard';

function createContext(channelId: string): ExecutionContext {
  const request = { params: { channelId }, user: { sub: 'user-id' } };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as ExecutionContext;
}

describe('ChannelOwnerGuard', () => {
  it('rejects malformed channel ids before querying ownership', async () => {
    const channels = { assertOwnership: jest.fn() };
    const guard = new ChannelOwnerGuard(channels as unknown as ChannelsService);

    await expect(
      guard.canActivate(createContext('not-a-uuid')),
    ).rejects.toBeInstanceOf(ChannelNotFoundException);
    expect(channels.assertOwnership).not.toHaveBeenCalled();
  });

  it('delegates the channel id and authenticated user id', async () => {
    const channels = {
      assertOwnership: jest.fn().mockResolvedValue(undefined),
    };
    const guard = new ChannelOwnerGuard(channels as unknown as ChannelsService);
    const channelId = '00000000-0000-4000-8000-000000000001';

    await expect(guard.canActivate(createContext(channelId))).resolves.toBe(
      true,
    );
    expect(channels.assertOwnership).toHaveBeenCalledWith(channelId, 'user-id');
  });
});
