import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { buildLoggerOptions } from '../common/logging/logger.options';
import { validateRelayEnv, type RelayEnv } from '../config/relay-env.schema';
import { PrismaModule } from '../prisma/prisma.module';
import { TaskEventReplayer } from './task-event-replayer';

/**
 * Módulo dos comandos operacionais de mensageria: replay (`src/replay.ts`) e redrive (`src/redrive.ts`). Ambiente do RELAY, e não um schema novo: o replay escreve na mesma
 * outbox que o relay lê, com o mesmo banco e sem segredo de token (menor privilégio, como os workers).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateRelayEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<RelayEnv, true>) =>
        buildLoggerOptions({
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
          LOG_PRETTY: config.get('LOG_PRETTY', { infer: true }),
        }),
    }),
    PrismaModule,
  ],
  providers: [TaskEventReplayer],
})
export class ReplayModule {}
