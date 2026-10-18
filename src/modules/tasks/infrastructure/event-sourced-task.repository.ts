import { Injectable } from '@nestjs/common';
import type { Event as StoredEvent } from '@prisma/client';
import { EventStoreService } from '../../../events/event-store.service';
import { TaskAggregate } from '../domain/task.aggregate';
import { TaskRepository } from '../domain/task.repository';
import type { TaskDomainEvent } from '../events/task.events';

const AGGREGATE_TYPE = 'Task';

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<TaskDomainEvent['type']>([
  'TaskCreated',
  'TaskAssigned',
  'TaskStatusChanged',
  'TaskCompleted',
]);

/** Implementação do TaskRepository sobre o Event Store (Postgres). */
@Injectable()
export class EventSourcedTaskRepository extends TaskRepository {
  constructor(private readonly eventStore: EventStoreService) {
    super();
  }

  async load(taskId: string): Promise<TaskAggregate | null> {
    const rows = await this.eventStore.loadEvents(taskId);
    if (rows.length === 0) {
      return null;
    }

    return TaskAggregate.fromHistory(rows.map(toDomainEvent));
  }

  async save(task: TaskAggregate): Promise<TaskDomainEvent[]> {
    const events = task.pullPendingEvents();
    if (events.length === 0) {
      return []; // nada mudou (ex.: comando idempotente) — não toca no banco
    }

    // Um único INSERT atômico; conflito de versão → ConcurrencyConflictError (409)
    await this.eventStore.appendMany(
      events.map((event) => ({
        aggregateId: task.id,
        aggregateType: AGGREGATE_TYPE,
        eventType: event.type,
        payload: { ...event.data },
      })),
      task.version,
    );

    return events;
  }
}

/** Type guard: depois deste `if`, o TypeScript sabe que a string é um dos tipos de evento conhecidos. */
function isKnownEventType(eventType: string): eventType is TaskDomainEvent['type'] {
  return KNOWN_EVENT_TYPES.has(eventType);
}

/**
 * Converte a linha do banco (event_type + payload JSON) no evento tipado do domínio.
 *
 * - O TIPO do evento é validado: um registro inesperado falha alto e cedo,
 *   em vez de produzir um agregado silenciosamente inconsistente.
 * - O PAYLOAD atravessa a fronteira de confiança com `as unknown as`: o Event Store
 *   só contém o que o próprio sistema gravou (via este repositório). É o ÚNICO cast
 *   de leitura do Event Store — concentrado e documentado aqui, nunca espalhado.
 */
export function toDomainEvent(row: StoredEvent): TaskDomainEvent {
  if (!isKnownEventType(row.eventType)) {
    throw new Error(`Evento desconhecido no stream da tarefa ${row.aggregateId}: "${row.eventType}"`);
  }

  return { type: row.eventType, data: row.payload } as unknown as TaskDomainEvent;
}
