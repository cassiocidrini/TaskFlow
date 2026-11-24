import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TasksController } from './tasks.controller';
import { CreateTaskHandler } from './commands/create-task.handler';
import { GetTasksHandler } from './queries/get-tasks.handler';
import { GetTaskHistoryHandler } from './queries/get-task-history.handler';
import { TaskCreatedHandler } from './events/task-created.handler';
import {
  TaskAssignedProjection,
  TaskCompletedProjection,
  TaskStatusChangedProjection,
} from './events/task-lifecycle.projections';
import { EventStoreService } from '../../events/event-store.service';
import { ProjectsModule } from '../projects/projects.module';
import { TaskRepository } from './domain/task.repository';
import { EventSourcedTaskRepository } from './infrastructure/event-sourced-task.repository';
import { TaskCommandRunner } from './commands/task-command.runner';
import {
  AssignTaskHandler,
  ChangeTaskStatusHandler,
  CompleteTaskHandler,
} from './commands/task-lifecycle.handlers';

/** Lado de ESCRITA (CQRS): cada handler recebe um comando e grava eventos. */
const CommandHandlers = [CreateTaskHandler, AssignTaskHandler, ChangeTaskStatusHandler, CompleteTaskHandler];

/** Lado de LEITURA (CQRS): listagem pelo Read Model e histórico pelo Event Store. */
const QueryHandlers = [GetTasksHandler, GetTaskHistoryHandler];

/** Projeções (Observer): mantêm o Read Model `tasks_read` sincronizado com os eventos. */
const EventHandlers = [
  TaskCreatedHandler,
  TaskAssignedProjection,
  TaskStatusChangedProjection,
  TaskCompletedProjection,
];

/**
 * Módulo de tarefas — o único que aplica **CQRS + Event Sourcing** no projeto.
 *
 * O grafo de dependências comunica a arquitetura:
 * - `ProjectsModule` é importado para o `assertOwner` (autorização por projeto, OWASP A01);
 * - **Repository Pattern:** quem pede `TaskRepository` (o contrato, em `domain/`) recebe o
 *   `EventSourcedTaskRepository` (a implementação, em `infrastructure/`). Trocar o armazenamento de eventos
 *   seria trocar UMA linha aqui;
 * - `TaskCommandRunner` é o roteiro compartilhado dos comandos de ciclo de vida.
 *
 * Atenção ao registrar um handler novo: o `tsc` não detecta um provider faltando — o erro de injeção só
 * aparece no BOOT da aplicação. Por isso os smoke tests de boot e os testes E2E.
 */
@Module({
  imports: [CqrsModule, ProjectsModule],
  controllers: [TasksController],
  providers: [
    EventStoreService,
    { provide: TaskRepository, useClass: EventSourcedTaskRepository },
    TaskCommandRunner,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
})
export class TasksModule {}
