import type { NotificationType } from '@prisma/client';
import type { TaskEvent } from './task-event.message';

/** O que o consumer sabe de uma tarefa (projeção local `notification_tasks`). */
export interface LocalTask {
  projectId: string;
  title: string;
  assigneeId: string | null;
}

export interface NotificationDraft {
  userId: string;
  type: NotificationType;
  message: string;
}

/** Decisão para um evento: o novo estado da projeção local (se mudar) e a notificação (se houver). */
export interface Decision {
  task?: LocalTask;
  notification?: NotificationDraft;
}

/**
 * Regras de notificação — função PURA (sem banco, sem Kafka), testada isoladamente.
 *
 * - `TaskCreated`: registra a tarefa; se já nasce com responsável, notifica-o.
 * - `TaskAssigned`: atualiza o responsável e o notifica.
 * - `TaskCompleted`: notifica o responsável atual.
 * - Ninguém é notificado de uma ação que ele mesmo fez (`destinatário = actorId`).
 * - Tarefa desconhecida (criada antes de existir este consumer, fora da retenção do tópico): sem título nem
 *   responsável, não há o que notificar com segurança, e a decisão é vazia.
 */
export function decide(event: TaskEvent, current: LocalTask | null): Decision {
  switch (event.eventType) {
    case 'TaskCreated': {
      const task: LocalTask = {
        projectId: event.projectId,
        title: event.data.title,
        assigneeId: event.data.assigneeId ?? null,
      };
      return { task, notification: assignedTo(task, event.actorId) };
    }
    case 'TaskAssigned': {
      if (!current) return {};
      const task: LocalTask = { ...current, assigneeId: event.data.assigneeId };
      return { task, notification: assignedTo(task, event.actorId) };
    }
    case 'TaskCompleted': {
      if (!current?.assigneeId || current.assigneeId === event.actorId)
        return {};
      return {
        notification: {
          userId: current.assigneeId,
          type: 'TASK_COMPLETED',
          message: `A tarefa "${current.title}" foi concluída`,
        },
      };
    }
  }
}

function assignedTo(
  task: LocalTask,
  actorId: string,
): NotificationDraft | undefined {
  if (!task.assigneeId || task.assigneeId === actorId) return undefined;
  return {
    userId: task.assigneeId,
    type: 'TASK_ASSIGNED',
    message: `Você foi atribuído à tarefa "${task.title}"`,
  };
}
