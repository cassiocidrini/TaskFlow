import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { TelemetryShutdownHook } from '../common/lifecycle/telemetry-shutdown';
import { buildLoggerOptions } from '../common/logging/logger.options';
import { validateRelayEnv, type RelayEnv } from '../config/relay-env.schema';
import { PrismaModule } from '../prisma/prisma.module';
import { KafkaMessagePublisher } from './kafka-message-publisher';
import { MessagePublisher } from './message-publisher';
import { OutboxRelay } from './outbox-relay.service';
import { OutboxStore } from './outbox.store';

/**
 * Módulo raiz do processo do relay (`src/relay.ts`). Não importa o `AppModule`: sem HTTP, sem auth, sem CQRS. Só o
 * que o relay usa — config (com o schema PRÓPRIO do relay), logs JSON, Prisma e telemetria.
 *
 * Ordem do encerramento (hooks do Nest): `OutboxRelay.onModuleDestroy` (termina o lote) →
 * `KafkaMessagePublisher.beforeApplicationShutdown` (descarrega o produtor) → Prisma e OpenTelemetry
 * (`onApplicationShutdown`).
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
  providers: [
    OutboxStore,
    // Porta → adapter: o relay depende de MessagePublisher; quem decide que é Kafka é este binding
    { provide: MessagePublisher, useClass: KafkaMessagePublisher },
    OutboxRelay,
    TelemetryShutdownHook,
  ],
})
export class RelayModule {}
