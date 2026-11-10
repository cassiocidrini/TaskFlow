import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { TelemetryShutdownHook } from '../../../common/lifecycle/telemetry-shutdown';
import { buildLoggerOptions } from '../../../common/logging/logger.options';
import {
  validateConsumerEnv,
  type ConsumerEnv,
} from '../../../config/consumer-env.schema';
import { PrismaModule } from '../../../prisma/prisma.module';
import { ReportsConsumer } from './reports.consumer';
import { ReportsHandler } from './reports.handler';

/**
 * Módulo raiz do processo consumer de relatórios (`src/reports-consumer.ts`). Como o do consumer de notificações: sem HTTP,
 * sem auth, sem CQRS; config com schema próprio, logs JSON, Prisma e telemetria.
 *
 * Encerramento: `ReportsConsumer.onModuleDestroy` (termina a mensagem e desconecta do Kafka) → Prisma e
 * OpenTelemetry (`onApplicationShutdown`).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateConsumerEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<ConsumerEnv, true>) =>
        buildLoggerOptions({
          LOG_LEVEL: config.get('LOG_LEVEL', { infer: true }),
          LOG_PRETTY: config.get('LOG_PRETTY', { infer: true }),
        }),
    }),
    PrismaModule,
  ],
  providers: [ReportsHandler, ReportsConsumer, TelemetryShutdownHook],
})
export class ReportsConsumerModule {}
