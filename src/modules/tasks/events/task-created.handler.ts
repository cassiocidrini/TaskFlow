import { Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { TaskCreatedEvent } from './task.events';
import { PrismaService } from '../../../prisma/prisma.service';

@EventsHandler(TaskCreatedEvent)
export class TaskCreatedHandler implements IEventHandler<TaskCreatedEvent> {
  private readonly logger = new Logger(TaskCreatedHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async handle(event: TaskCreatedEvent): Promise<void> {
    try {
      // Projeção IDEMPOTENTE: INSERT ... ON CONFLICT DO NOTHING.
      // Eventos podem ser entregues mais de uma vez (retry, replay) — a 2ª entrega vira no-op.
      await this.prisma.taskRead.createMany({
        data: [
          {
            id: event.taskId,
            projectId: event.projectId,
            title: event.title,
            assigneeId: event.assigneeId,
            status: 'PENDING',
            priority: event.priority,
            dueDate: event.dueDate ? new Date(event.dueDate) : null,
          },
        ],
        skipDuplicates: true,
      });
    } catch (error) {
      // O publish() do EventBus é fire-and-forget: o cliente já recebeu 201.
      // Sem este log, uma falha de projeção seria INVISÍVEL (tarefa some do GET sem rastro).
      this.logger.error(
        `Falha ao projetar TaskCreated (taskId=${event.taskId}) em tasks_read`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    }
  }
}
