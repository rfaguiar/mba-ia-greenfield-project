import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import appConfig from '../config/app.config';
import authConfig from '../config/auth.config';
import mailConfig from '../config/mail.config';
import { createTestDataSource } from '../test/create-test-data-source';
import { AuthModule } from './auth.module';

import { ALL_ENTITIES } from '../test/all-entities';

describe('AuthModule', () => {
  it('should compile successfully with JwtModule, TypeOrmModule, UsersModule, and MailModule', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [appConfig, authConfig, mailConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        AuthModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
