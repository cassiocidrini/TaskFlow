import { NotFoundException } from '@nestjs/common';
import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { toEventMetadata } from '../../../events/event-metadata';
import { EventStoreService } from '../../../events/event-store.service';
import { ProjectsService } from '../../projects/projects.service';
import { TaskAggregate } from '../domain/task.aggregate';
import { toDomainEvent } from '../infrastructure/event-sourced-task.repository';
import type { TaskDomainEvent, TaskPriority, TaskStatus } from '../events/task.events';
import { GetTaskHistoryQuery } from './get-task-history.query';

/**
 * Um evento da linha do tempo, como gravado no Event Store. Contrato público: `TaskHistoryEntryDto`.
 *
 * `eventId`, `actorId` e `correlationId` vêm do envelope de metadados e são `null` em eventos gravados antes
 * dele existir: o histórico é append-only, então o passado não é reescrito nem tem o autor "adivinhado".
 */
export interface TaskHistoryEntry {
  eventId: string | null;
  version: number;
  type: TaskDomainEvent['type'];
  data: TaskDomainEvent['data'];
  actorId: string | null;
  correlationId: string | null;
  occurredAt: Date;
}

/** Histórico + estado atual. Contrato público (Swagger): `TaskHistoryDto`. */
export interface TaskHistory {
  taskId: string;
  /** Estado atual RECONSTRUÍDO a partir dos eventos abaixo (não lido do Read Model) */
  current: {
    title: string;
    status: TaskStatus;
    priority: TaskPriority;
    assigneeId?: string;
    dueDate?: string;
    completedAt?: string;
    version: number;
  };
  /** Linha do tempo completa, do mais antigo ao mais recente */
  history: TaskHistoryEntry[];
}

/**
 * A vitrine do Event Sourcing: o histórico NÃO é um log à parte — ele É o dado.
 * Lê o stream UMA vez e deriva dele tanto a linha do tempo quanto o estado atual.
 */
@QueryHandler(GetTaskHistoryQuery)
export class GetTaskHistoryHandler implements IQueryHandler<GetTaskHistoryQuery, TaskHistory> {
  constructor(
    private readonly projects: ProjectsService,
    private readonly eventStore: EventStoreService,
  ) {}

  async execute({ target }: GetTaskHistoryQuery): Promise<TaskHistory> {
    // Mesmas regras de acesso dos comandos: dono do projeto + tarefa pertencente a ESTE projeto
    await this.projects.assertOwner(target.projectId, target.userId);

    const rows = await this.eventStore.loadEvents(target.taskId);
    if (rows.length === 0) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    const events = rows.map(toDomainEvent);
    const task = TaskAggregate.fromHistory(events);
    if (task.projectId !== target.projectId) {
      throw new NotFoundException('Tarefa não encontrada'); // anti-IDOR: mesmo 404
    }

    return {
      taskId: task.id,
      current: {
        title: task.title,
        status: task.status,
        priority: task.priority,
        assigneeId: task.assigneeId,
        dueDate: task.dueDate,
        completedAt: task.completedAt,
        version: task.version,
      },
      history: rows.map((row, i) => {
        const metadata = toEventMetadata(row.metadata);
        return {
          eventId: metadata.eventId ?? null,
          version: row.version,
          type: events[i].type,
          data: events[i].data,
          actorId: metadata.actorId ?? null,
          correlationId: metadata.correlationId ?? null,
          occurredAt: row.createdAt,
        };
      }),
    };
  }
}
