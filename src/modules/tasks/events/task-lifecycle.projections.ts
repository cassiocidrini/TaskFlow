import { Logger } from '@nestjs/common';
import { EventsHandler, IEventHandler } from '@nestjs/cqrs';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TaskAssignedEvent, TaskCompletedEvent, TaskStatusChangedEvent } from './task.events';

/**
 * Projeções dos eventos de ciclo de vida → tasks_read.
 *
 * UPDATEs "SET coluna = valor" são idempotentes por natureza: reaplicar o mesmo evento dá o mesmo resultado.
 * updateMany (e não update) para não lançar quando a linha não existe — isso indica evento fora de ordem
 * (ex.: TaskAssigned processado antes do TaskCreated) e vira WARN, não queda do handler.
 *
 * Limitação conhecida: o EventBus em memória entrega em ordem; com um broker externo (SQS/SNS) seria preciso
 * guardar a versão do agregado no read model e ignorar eventos mais antigos que ela.
 */
async function project(
  prisma: PrismaService,
  logger: Logger,
  eventName: string,
  taskId: string,
  data: Prisma.TaskReadUpdateManyMutationInput,
): Promise<void> {
  try {
    const { count } = await prisma.taskRead.updateMany({ where: { id: taskId }, data });
    if (count === 0) {
      logger.warn(`${eventName} para tarefa ausente em tasks_read (taskId=${taskId}) — evento fora de ordem?`);
    }
  } catch (error) {
    logger.error(
      `Falha ao projetar ${eventName} (taskId=${taskId}) em tasks_read`,
      error instanceof Error ? error.stack : String(error),
    );
    throw error;
  }
}

/** `TaskAssigned` → atualiza `assignee_id`. O último evento aplicado vence, como no agregado. */
@EventsHandler(TaskAssignedEvent)
export class TaskAssignedProjection implements IEventHandler<TaskAssignedEvent> {
  private readonly logger = new Logger(TaskAssignedProjection.name);

  constructor(private readonly prisma: PrismaService) {}

  handle(event: TaskAssignedEvent): Promise<void> {
    return project(this.prisma, this.logger, 'TaskAssigned', event.taskId, { assigneeId: event.assigneeId });
  }
}

/**
 * `TaskStatusChanged` → grava o status de DESTINO (`to`). O `from` fica só no Event Store: o Read Model guarda
 * o "agora"; quem quiser a trajetória consulta o histórico.
 */
@EventsHandler(TaskStatusChangedEvent)
export class TaskStatusChangedProjection implements IEventHandler<TaskStatusChangedEvent> {
  private readonly logger = new Logger(TaskStatusChangedProjection.name);

  constructor(private readonly prisma: PrismaService) {}

  handle(event: TaskStatusChangedEvent): Promise<void> {
    return project(this.prisma, this.logger, 'TaskStatusChanged', event.taskId, { status: event.to });
  }
}

/**
 * `TaskCompleted` → `status = DONE` + `completed_at`. A data chega como string ISO (o evento é uma mensagem
 * serializada) e só vira `Date` aqui, na borda com o banco.
 */
@EventsHandler(TaskCompletedEvent)
export class TaskCompletedProjection implements IEventHandler<TaskCompletedEvent> {
  private readonly logger = new Logger(TaskCompletedProjection.name);

  constructor(private readonly prisma: PrismaService) {}

  handle(event: TaskCompletedEvent): Promise<void> {
    return project(this.prisma, this.logger, 'TaskCompleted', event.taskId, {
      status: 'DONE',
      completedAt: new Date(event.completedAt),
    });
  }
}
