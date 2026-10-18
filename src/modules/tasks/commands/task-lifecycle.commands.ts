import type { OpenTaskStatus } from '../events/task.events';
import type { TaskCommandTarget } from './task-command.runner';

// Todos recebem o `target` NOMEADO ({ userId, projectId, taskId }) + no máximo um valor de tipo distinto:
// trocar a ordem dos argumentos não compila.

export class AssignTaskCommand {
  constructor(
    public readonly target: TaskCommandTarget,
    public readonly assigneeId: string,
  ) {}
}

export class ChangeTaskStatusCommand {
  constructor(
    public readonly target: TaskCommandTarget,
    public readonly status: OpenTaskStatus,
  ) {}
}

export class CompleteTaskCommand {
  constructor(public readonly target: TaskCommandTarget) {}
}
