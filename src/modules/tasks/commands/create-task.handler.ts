import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import { CreateTaskCommand } from './create-task.command';
import { EventStoreService } from '../../events/event-store.service';
import { TaskCreatedEvent } from '../events/task.events';

@CommandHandler(CreateTaskCommand)
export class CreateTaskHandler implements ICommandHandler<CreateTaskCommand> {
  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: CreateTaskCommand): Promise<string> {
    const taskId = randomUUID();

    // 1. Persiste o evento no Event Store (append-only)
    await this.eventStore.append({
      aggregateId: taskId,
      aggregateType: 'Task',
      eventType: 'TaskCreated',
      payload: {
        taskId,
        projectId: command.projectId,
        title: command.title,
        assigneeId: command.assigneeId,
      },
    });

    // 2. Publica o evento (para projeções reagirem)
    this.eventBus.publish(
      new TaskCreatedEvent(taskId, command.projectId, command.title, command.assigneeId),
    );

    return taskId;
  }
}