import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaConsumerRunner } from '../../../common/messaging/kafka-consumer.runner';
import type { ConsumerEnv } from '../../../config/consumer-env.schema';
import { TASK_EVENTS_TOPIC } from '../../tasks/events/task.integration-events';
import { REPORTS_GROUP, ReportsHandler } from './reports.handler';

/** DLT do grupo `reports`: criado pelo `kafka-init`. Separado do DLT do `notifications` (a falha é de cada grupo). */
export const REPORTS_DLT = 'taskflow.reports-dlt.v1';

/**
 * Liga o {@link ReportsHandler} ao Kafka: consumer group `reports` em `taskflow.task-events.v1`.
 *
 * Mesmo tópico do `notifications`, outro grupo: cada grupo lê o tópico INTEIRO e guarda o próprio offset. Um não
 * espera o outro, e o lag de cada um é medido à parte.
 */
@Injectable()
export class ReportsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReportsConsumer.name);
  private readonly runner: KafkaConsumerRunner;

  constructor(
    handler: ReportsHandler,
    config: ConfigService<ConsumerEnv, true>,
  ) {
    this.runner = new KafkaConsumerRunner({
      brokers: config.get('KAFKA_BROKERS', { infer: true }),
      groupId: REPORTS_GROUP,
      topics: [TASK_EVENTS_TOPIC],
      partitionsConsumedConcurrently: 3,
      handle: (message) => handler.handle(message),
      deadLetterTopic: REPORTS_DLT,
      logger: this.logger,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.runner.start();
  }

  /** 1º passo do shutdown: termina a mensagem em andamento e desconecta, ANTES de o Prisma fechar. */
  async onModuleDestroy(): Promise<void> {
    await this.runner.stop();
  }
}
