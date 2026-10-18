import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import { CreateTaskCommand } from './create-task.command';
import { EventStoreService } from '../../../events/event-store.service';
import { TaskCreatedEvent } from '../events/task.events';
import { KeywordPriorityStrategy } from '../strategies/task-priority.strategy';
import { ProjectsService } from '../../projects/projects.service';

@CommandHandler(CreateTaskCommand)
export class CreateTaskHandler implements ICommandHandler<CreateTaskCommand> {
  // Injetando a estratégia
  private priorityStrategy = new KeywordPriorityStrategy();

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBus,
    private readonly projects: ProjectsService,
  ) {}

  async execute(command: CreateTaskCommand): Promise<string> {
    // 1º de tudo: autorização. O Event Store é append-only — um evento gravado
    // indevidamente nunca mais sai. Lança 404 se o projeto não for do usuário.
    await this.projects.assertOwner(command.projectId, command.userId);

    const taskId = randomUUID();
    
    // Calcula a prioridade usando a estratégia injetada
    const priority = this.priorityStrategy.calculate(command.title, command.dueDate);

    await this.eventStore.append({
      aggregateId: taskId,
      aggregateType: 'Task',
      eventType: 'TaskCreated',
      payload: {
        taskId,
        projectId: command.projectId,
        title: command.title,
        assigneeId: command.assigneeId, // <-- Recuperamos isso
        priority,                       // <-- Mantemos a prioridade
      },
    });

    // Corrigimos a ordem dos argumentos: taskId, projectId, title
    this.eventBus.publish(new TaskCreatedEvent(taskId, command.projectId, command.title, command.assigneeId));
    return taskId;
  }
}