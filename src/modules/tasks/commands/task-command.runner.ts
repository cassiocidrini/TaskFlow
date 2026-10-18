import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { ProjectsService } from '../../projects/projects.service';
import { TaskAggregate, TaskInvariantError } from '../domain/task.aggregate';
import { TaskRepository } from '../domain/task.repository';
import {
  TaskAssignedEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskStatusChangedEvent,
  type TaskDomainEvent,
  type TaskStatus,
} from '../events/task.events';

/** Identifica QUEM quer mexer em QUAL tarefa de QUAL projeto. Todo comando de ciclo de vida carrega isto. */
export interface TaskCommandTarget {
  userId: string;
  projectId: string;
  taskId: string;
}

/** Estado resumido devolvido ao cliente após um comando. */
export interface TaskSnapshot {
  taskId: string;
  status: TaskStatus;
  assigneeId?: string;
  completedAt?: string;
}

/**
 * Roteiro ÚNICO de todo comando que altera uma tarefa existente (Template Method funcional):
 *   autoriza → carrega → aplica regra de domínio → persiste → publica.
 *
 * Os handlers só informam o passo variável (`mutate`). Autorização, tradução de erros
 * e a ordem save → publish ficam aqui, escritas e testadas uma única vez.
 */
@Injectable()
export class TaskCommandRunner {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repository: TaskRepository,
    private readonly eventBus: EventBus,
  ) {}

  async run(target: TaskCommandTarget, mutate: (task: TaskAggregate) => void): Promise<TaskSnapshot> {
    // 1. Autorização: o projeto é do usuário? (404 se não for)
    await this.projects.assertOwner(target.projectId, target.userId);

    // 2. Carrega o agregado. Tarefa de OUTRO projeto = mesmo 404 (anti-IDOR e anti-enumeration)
    const task = await this.repository.load(target.taskId);
    if (!task || task.projectId !== target.projectId) {
      throw new NotFoundException('Tarefa não encontrada');
    }

    // 3. Regra de negócio. Erro de domínio (não conhece HTTP) é traduzido aqui, na borda
    try {
      mutate(task);
    } catch (error) {
      if (error instanceof TaskInvariantError) {
        throw new ConflictException(error.message);
      }
      throw error;
    }

    // 4. Persiste (concorrência otimista: ConcurrencyConflictError já é um 409)
    const saved = await this.repository.save(task);

    // 5. Publica SOMENTE o que foi gravado, na ordem em que foi gravado
    for (const event of saved) {
      this.eventBus.publish(toBusEvent(event));
    }

    return {
      taskId: task.id,
      status: task.status,
      assigneeId: task.assigneeId,
      completedAt: task.completedAt,
    };
  }
}

/** Converte o evento do domínio (type + data) na classe que o EventBus do Nest roteia para os @EventsHandler. */
export function toBusEvent(event: TaskDomainEvent) {
  switch (event.type) {
    case 'TaskCreated':
      return new TaskCreatedEvent(event.data);
    case 'TaskAssigned':
      return new TaskAssignedEvent(event.data);
    case 'TaskStatusChanged':
      return new TaskStatusChangedEvent(event.data);
    case 'TaskCompleted':
      return new TaskCompletedEvent(event.data);
    default: {
      const _exhaustive: never = event;
      throw new Error(`Evento sem classe de barramento: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
