import type { Event as StoredEvent, Prisma } from '@prisma/client';
import { toEventMetadata } from '../events/event-metadata';
import {
  toTaskOutboxMessage,
  UNKNOWN_ACTOR_ID,
} from '../modules/tasks/events/task.integration-events';
import type { TaskCreatedData } from '../modules/tasks/events/task.events';
import { toDomainEvent } from '../modules/tasks/infrastructure/event-sourced-task.repository';

/**
 * Linhas de `events` (de uma ou mais tarefas, em ordem de tarefa e versão) → linhas da outbox marcadas como replay
 * (Módulo 13.6b). Função PURA: o serviço cuida do lote, do lock e do INSERT; esta, só da tradução.
 *
 * Passa pelo MESMO mapper da API (`toTaskOutboxMessage`): o replay publica exatamente o contrato que a API publicaria,
 * e um campo novo no contrato chega aos dois caminhos sem duplicação.
 *
 * O envelope vem da linha gravada, não de agora:
 * - `eventId` do envelope; num evento LEGADO (sem envelope), o `id` da linha em `events`. É estável: rodar o replay
 *   duas vezes gera o mesmo `eventId`, e a idempotência dos consumers continua valendo;
 * - `actorId` do envelope; num legado, {@link UNKNOWN_ACTOR_ID};
 * - `occurredAt` = `created_at` original; `aggregateVersion` = `version` original (a guarda das projeções depende dela);
 * - `projectId` do `TaskCreated` da tarefa (a versão 1).
 *
 * @throws se a primeira linha de uma tarefa não for o `TaskCreated`: o stream está incompleto, e publicar o resto
 *         geraria eventos sem projeto. Falha alto em vez de pular em silêncio.
 */
export function toReplayMessages(
  rows: readonly StoredEvent[],
  now: Date,
): Prisma.OutboxMessageCreateManyInput[] {
  const projectOf = new Map<string, string>();
  return rows.flatMap((row) => {
    const event = toDomainEvent(row);
    if (event.type === 'TaskCreated') {
      projectOf.set(row.aggregateId, (event.data as TaskCreatedData).projectId);
    }
    const projectId = projectOf.get(row.aggregateId);
    if (!projectId) {
      throw new Error(
        `Tarefa ${row.aggregateId}: a versão ${row.version} (${row.eventType}) veio antes do TaskCreated; stream incompleto`,
      );
    }

    const metadata = toEventMetadata(row.metadata);
    const message = toTaskOutboxMessage(
      event,
      {
        metadata: {
          eventId: metadata.eventId ?? row.id,
          actorId: metadata.actorId ?? UNKNOWN_ACTOR_ID,
          ...(metadata.correlationId
            ? { correlationId: metadata.correlationId }
            : {}),
          schemaVersion: metadata.schemaVersion ?? 1,
        },
        aggregateVersion: row.version,
        recordedAt: row.createdAt,
      },
      projectId,
    );
    return [
      {
        eventId: metadata.eventId ?? row.id,
        topic: message.topic,
        messageKey: message.key,
        eventType: message.eventType,
        payload: message.payload as Prisma.InputJsonObject,
        replay: true,
        createdAt: now,
      },
    ];
  });
}
