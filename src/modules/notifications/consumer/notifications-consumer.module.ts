import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { TelemetryShutdownHook } from '../../../common/lifecycle/telemetry-shutdown';
import { buildLoggerOptions } from '../../../common/logging/logger.options';
import {
  validateConsumerEnv,
  type ConsumerEnv,
} from '../../../config/consumer-env.schema';
import { PrismaModule } from '../../../prisma/prisma.module';
import { NotificationsConsumer } from './notifications.consumer';
import { NotificationsHandler } from './notifications.handler';
import { DisabledPushQueue, PushQueue } from './push-queue';
import { SqsPushQueue } from './sqs-push-queue';

const logger = new Logger('NotificationsConsumerModule');

/**
 * Módulo raiz do processo consumer de notificações (`src/notifications-consumer.ts`). Como o do relay: sem HTTP,
 * sem auth, sem CQRS; config com schema próprio, logs JSON, Prisma e telemetria.
 *
 * O adapter do push (Módulo 13.7) é escolhido pela configuração: `SqsPushQueue` com `PUSH_QUEUE_URL`,
 * `DisabledPushQueue` sem ela. A troca é só aqui; o handler conhece apenas a porta `PushQueue`.
 *
 * Encerramento: `NotificationsConsumer.onModuleDestroy` (termina a mensagem e desconecta do Kafka) → Prisma, cliente
 * do SQS e OpenTelemetry (`onApplicationShutdown`).
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
  providers: [
    NotificationsHandler,
    NotificationsConsumer,
    TelemetryShutdownHook,
    {
      provide: PushQueue,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ConsumerEnv, true>): PushQueue => {
        const queueUrl = config.get('PUSH_QUEUE_URL', { infer: true });
        if (!queueUrl) {
          logger.warn(
            'PUSH_QUEUE_URL não configurada: notificações gravadas sem envio de push',
          );
          return new DisabledPushQueue();
        }
        logger.log(`Push enfileirado no SQS: ${queueUrl}`);
        return new SqsPushQueue({
          queueUrl,
          region: config.get('AWS_REGION', { infer: true }),
          endpoint: config.get('AWS_ENDPOINT_URL', { infer: true }),
        });
      },
    },
  ],
})
export class NotificationsConsumerModule {}
