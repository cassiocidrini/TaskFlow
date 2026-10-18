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

const CommandHandlers = [CreateTaskHandler, AssignTaskHandler, ChangeTaskStatusHandler, CompleteTaskHandler];
const QueryHandlers = [GetTasksHandler, GetTaskHistoryHandler];
const EventHandlers = [
  TaskCreatedHandler,
  TaskAssignedProjection,
  TaskStatusChangedProjection,
  TaskCompletedProjection,
];

@Module({
  // ProjectsModule fornece o ProjectsService (assertOwner) aos handlers
  imports: [CqrsModule, ProjectsModule],
  controllers: [TasksController],
  providers: [
    EventStoreService,
    // Repository Pattern: quem pede TaskRepository (contrato) recebe a implementação event-sourced
    { provide: TaskRepository, useClass: EventSourcedTaskRepository },
    TaskCommandRunner,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
})
export class TasksModule {}