import type { ConfigType } from '@nestjs/config';
import databaseConfig from '../config/database.config';

export function typeOrmOptionsFactory(
  dbConfig: ConfigType<typeof databaseConfig>,
) {
  return {
    type: 'postgres' as const,
    host: dbConfig.host,
    port: dbConfig.port,
    username: dbConfig.username,
    password: dbConfig.password,
    database: dbConfig.name,
    autoLoadEntities: true,
    synchronize: false,
  };
}
