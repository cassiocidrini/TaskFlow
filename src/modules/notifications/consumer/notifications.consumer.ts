import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaConsumerRunner } from '../../../common/messaging/kafka-consumer.runner';
import { ProcessedEventsCleaner } from '../../../common/messaging/processed-events.cleaner';
import type { ConsumerEnv } from '../../../config/consumer-env.schema';
import { PrismaService } from '../../../prisma/prisma.service';
import { TASK_EVENTS_TOPIC } from '../../tasks/events/task.integration-events';
import {
  NOTIFICATIONS_GROUP,
  NotificationsHandler,
} from './notifications.handler';

/** DLT do grupo `notifications`: criado pelo `kafka-init`, com retenção maior que a do tópico de origem. */
export const NOTIFICATIONS_DLT = 'taskflow.notifications-dlt.v1';

/**
 * Liga o {@link NotificationsHandler} ao Kafka: consumer group `notifications` em `taskflow.task-events.v1`.
 *
 * As 3 partições são processadas em paralelo (uma mensagem por vez em cada, preservando a ordem por tarefa). Mais
 * de 3 réplicas deste processo não ajudariam: cada partição é lida por no máximo um consumidor do grupo.
 *
 * Mensagem envenenada (malformada, ou que esgotou as tentativas) vai para `taskflow.notifications-dlt.v1`, e a
 * partição segue; banco fora não manda nada para lá (ver `consumer-errors.ts`).
 *
 * O nome do tópico vem da constante do produtor: é o ENDEREÇO do contrato, não o formato (que o consumer copia em
 * `task-event.message.ts`).
 */
@Injectable()
export class NotificationsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationsConsumer.name);
  private readonly runner: KafkaConsumerRunner;
  private readonly cleaner: ProcessedEventsCleaner;

  constructor(
    handler: NotificationsHandler,
    config: ConfigService<ConsumerEnv, true>,
    prisma: PrismaService,
  ) {
    this.runner = new KafkaConsumerRunner({
      brokers: config.get('KAFKA_BROKERS', { infer: true }),
      groupId: NOTIFICATIONS_GROUP,
      topics: [TASK_EVENTS_TOPIC],
      partitionsConsumedConcurrently: 3,
      handle: (message) => handler.handle(message),
      deadLetterTopic: NOTIFICATIONS_DLT,
      // Efeito colateral: republicar o histórico não pode avisar de novo uma atribuição antiga
      acceptsReplay: false,
      logger: this.logger,
    });
    // A idempotência deste grupo é a tabela de marcas: ele mesmo apaga as que passaram da retenção (13.6c)
    this.cleaner = new ProcessedEventsCleaner(prisma, {
      consumerGroup: NOTIFICATIONS_GROUP,
      retentionDays: config.get('PROCESSED_EVENTS_RETENTION_DAYS', {
        infer: true,
      }),
      logger: this.logger,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.runner.start();
    this.cleaner.start();
  }

  /**
   * 1º passo do shutdown: termina a mensagem em andamento e desconecta, e espera uma limpeza em andamento, ANTES de o
   * Prisma fechar.
   */
  async onModuleDestroy(): Promise<void> {
    await Promise.all([this.runner.stop(), this.cleaner.stop()]);
  }
}
