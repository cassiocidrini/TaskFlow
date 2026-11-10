import { Injectable } from '@nestjs/common';
import type { Event as StoredEvent } from '@prisma/client';
import { EventStoreService, type DomainEvent } from '../../../events/event-store.service';
import { TaskAggregate } from '../domain/task.aggregate';
import { TaskRepository, type SaveContext } from '../domain/task.repository';
import { toTaskOutboxMessage } from '../events/task.integration-events';
import { TASK_EVENT_SCHEMA_VERSIONS, type TaskDomainEvent } from '../events/task.events';

const AGGREGATE_TYPE = 'Task';

const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set<TaskDomainEvent['type']>([
  'TaskCreated',
  'TaskAssigned',
  'TaskStatusChanged',
  'TaskCompleted',
]);

/**
 * Implementação do {@link TaskRepository} sobre o Event Store (Postgres).
 *
 * É ao mesmo tempo um **Repository** (para o domínio, "carregar e salvar tarefas") e um **Adapter**
 * (Hexagonal: converte essas operações em "ler o stream de eventos e reidratar" / "gravar eventos pendentes").
 * O domínio depende só do contrato em `domain/`; esta classe é a única que sabe que existe um Event Store.
 *
 * - `load`: lê o stream do agregado e o reconstrói com `TaskAggregate.fromHistory` (replay).
 * - `save`: grava os eventos pendentes num ÚNICO `INSERT` atômico (`appendMany`), com
 *   `expectedVersion = task.version` — a concorrência otimista que transforma uma corrida em 409. Na mesma
 *   transação, cada evento vira um evento de INTEGRAÇÃO na outbox (Módulo 13.2), com o `projectId` da tarefa.
 */
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

  async save(task: TaskAggregate, context: SaveContext): Promise<TaskDomainEvent[]> {
    const events = task.pullPendingEvents();
    if (events.length === 0) {
      return []; // nada mudou (ex.: comando idempotente) — não toca no banco
    }

    const stored = events.map(
      (event): DomainEvent => ({
        aggregateId: task.id,
        aggregateType: AGGREGATE_TYPE,
        eventType: event.type,
        payload: { ...event.data },
        schemaVersion: TASK_EVENT_SCHEMA_VERSIONS[event.type],
      }),
    );
    // O Event Store devolve ao mapper o MESMO objeto que recebeu: daí se volta ao evento tipado, sem cast do payload
    const typedByStored = new Map(stored.map((storedEvent, index) => [storedEvent, events[index]]));

    // Eventos + outbox numa transação; conflito de versão → ConcurrencyConflictError (409) e nenhuma das duas
    await this.eventStore.appendMany(stored, task.version, { actorId: context.actorId }, {
      toOutbox: ({ event, ...recorded }) => toTaskOutboxMessage(typedByStored.get(event)!, recorded, task.projectId),
    });

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
