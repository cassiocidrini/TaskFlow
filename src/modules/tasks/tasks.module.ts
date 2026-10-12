import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { TasksController } from './tasks.controller';
import { CreateTaskHandler } from './commands/create-task.handler';
import { GetTasksHandler } from './queries/get-tasks.handler';
import { TaskCreatedHandler } from './events/task-created.handler';
import { EventStoreService } from '../../events/event-store.service';

const CommandHandlers = [CreateTaskHandler];
const QueryHandlers = [GetTasksHandler];
const EventHandlers = [TaskCreatedHandler];

@Module({
  imports: [CqrsModule],
  controllers: [TasksController],
  providers: [
    EventStoreService,
    ...CommandHandlers,
    ...QueryHandlers,
    ...EventHandlers,
  ],
})
export class TasksModule {}