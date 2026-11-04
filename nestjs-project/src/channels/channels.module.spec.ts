import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { createTestDataSource } from '../test/create-test-data-source';
import { ChannelsModule } from './channels.module';

import { ALL_ENTITIES } from '../test/all-entities';

describe('ChannelsModule', () => {
  it('should compile with TypeOrmModule.forFeature([Channel]) and ChannelsService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        ChannelsModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
