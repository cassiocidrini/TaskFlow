import type { OpenTaskStatus } from '../events/task.events';
import type { TaskCommandTarget } from './task-command.runner';

/*
 * Comandos CQRS do ciclo de vida de uma tarefa existente.
 *
 * Todos recebem o `target` NOMEADO ({ userId, projectId, taskId }) + no máximo um valor de tipo distinto.
 * Trocar a ordem dos argumentos NÃO compila — lição aprendida depois que parâmetros posicionais do mesmo
 * tipo (`string, string, string`) gravaram a prioridade no lugar do título de um evento.
 *
 * O `userId` do target vem sempre do JWT (controller → `@CurrentUser()`), nunca do cliente (OWASP A01).
 */

/** Intenção de trocar o responsável. Gera `TaskAssigned` (ou nada, se já for o mesmo responsável). */
export class AssignTaskCommand {
  constructor(
    public readonly target: TaskCommandTarget,
    public readonly assigneeId: string,
  ) {}
}

/**
 * Intenção de mover a tarefa entre os status ABERTOS. O tipo `OpenTaskStatus` exclui `DONE` no compilador:
 * concluir é um comando próprio ({@link CompleteTaskCommand}).
 */
export class ChangeTaskStatusCommand {
  constructor(
    public readonly target: TaskCommandTarget,
    public readonly status: OpenTaskStatus,
  ) {}
}

/** Intenção de concluir — ação terminal, que registra `completedAt`. */
export class CompleteTaskCommand {
  constructor(public readonly target: TaskCommandTarget) {}
}
