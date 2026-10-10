import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import { TaskCreatedEvent } from './task.events';
import { PrismaService } from '../../prisma/prisma.service';

@EventsHandler(TaskCreatedEvent)
export class TaskCreatedHandler implements IEventHandler<TaskCreatedEvent> {
  constructor(private readonly prisma: PrismaService) {}

  async handle(event: TaskCreatedEvent): Promise<void> {
    // Projeta o evento na tabela de leitura
    await this.prisma.taskRead.create({
      data: {
        id: event.taskId,
        projectId: event.projectId,
        title: event.title,
        assigneeId: event.assigneeId,
        status: 'PENDING',
      },
    });
  }
}