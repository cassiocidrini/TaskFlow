import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import { CreateTaskCommand } from './create-task.command';
import { EventStoreService } from '../../../events/event-store.service';
import { TaskCreatedEvent } from '../events/task.events';
import { KeywordPriorityStrategy } from '../strategies/task-priority.strategy';

@CommandHandler(CreateTaskCommand)
export class CreateTaskHandler implements ICommandHandler<CreateTaskCommand> {
  // Injetando a estratégia
  private priorityStrategy = new KeywordPriorityStrategy();

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBus,
  ) {}

  async execute(command: CreateTaskCommand): Promise<string> {
    const taskId = randomUUID();
    
    // Usando a estratégia para calcular a prioridade
    const priority = this.priorityStrategy.calculate(command.title, command.dueDate);

    await this.eventStore.append({
      aggregateId: taskId,
      aggregateType: 'Task',
      eventType: 'TaskCreated',
      payload: {
        taskId,
        projectId: command.projectId,
        title: command.title,
        priority, // <-- Gravando a prioridade no evento
      },
    });

    this.eventBus.publish(new TaskCreatedEvent(taskId, command.title, priority));
    return taskId;
  }
}