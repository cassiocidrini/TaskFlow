import { Injectable, Logger } from '@nestjs/common';
import type {
  ConsumedMessage,
  HandleResult,
} from '../../../common/messaging/kafka-consumer.runner';
import { PrismaService } from '../../../prisma/prisma.service';
import { decide } from './notification-rules';
import { parseTaskEvent, type TaskEvent } from './task-event.message';

/** Nome do consumer group no Kafka E a chave em `processed_events`: um só nome para as duas coisas. */
export const NOTIFICATIONS_GROUP = 'notifications';

/**
 * Processa um evento de tarefa para o contexto de notificações (Módulo 13.4).
 *
 * **Idempotência na mesma transação do efeito:**
 * ```
 * BEGIN
 *   INSERT processed_events (notifications, eventId) ON CONFLICT DO NOTHING   → 0 linhas = duplicata: sai
 *   atualiza a projeção local + INSERT notifications                         → o efeito
 * COMMIT
 * ```
 * Marca e efeito juntos, ou nenhum dos dois. Marcar fora da transação recriaria o dual-write da outbox (13.2) do lado
 * do consumer: um crash entre as duas escritas perderia a notificação (marcada e não feita) ou a duplicaria (feita e
 * não marcada).
 *
 * Duas entregas SIMULTÂNEAS do mesmo evento (rebalance no meio do processamento) também ficam corretas: o segundo
 * INSERT espera o lock da PK até o primeiro COMMIT e então não insere nada.
 */
@Injectable()
export class NotificationsHandler {
  private readonly logger = new Logger(NotificationsHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async handle(message: ConsumedMessage): Promise<HandleResult> {
    const parsed = parseTaskEvent(message.value);
    if (parsed.kind === 'ignored') {
      this.logger.debug(
        `Ignorado (partição ${message.partition}, offset ${message.offset}): ${parsed.reason}`,
      );
      return 'ignored';
    }
    return this.apply(parsed.event);
  }

  private async apply(event: TaskEvent): Promise<HandleResult> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.processedEvent.createMany({
        data: [{ consumerGroup: NOTIFICATIONS_GROUP, eventId: event.eventId }],
        skipDuplicates: true, // ON CONFLICT DO NOTHING
      });
      if (count === 0) {
        return 'duplicate';
      }

      const current = await tx.notificationTask.findUnique({
        where: { taskId: event.aggregateId },
      });
      const decision = decide(event, current);

      if (decision.task) {
        await tx.notificationTask.upsert({
          where: { taskId: event.aggregateId },
          create: { taskId: event.aggregateId, ...decision.task },
          update: decision.task,
        });
      }
      if (decision.notification) {
        await tx.notification.create({
          data: {
            ...decision.notification,
            taskId: event.aggregateId,
            projectId: event.projectId,
            eventId: event.eventId,
          },
        });
      }
      if (!current && event.eventType !== 'TaskCreated') {
        this.logger.warn(
          `${event.eventType} da tarefa ${event.aggregateId} sem o TaskCreated correspondente (anterior a este consumer?): nada a notificar`,
        );
      }
      return 'processed';
    });
  }
}
