import type { TaskCommandTarget } from '../commands/task-command.runner';

/**
 * Query CQRS: a linha do tempo completa de uma tarefa, lida do Event Store.
 *
 * Reaproveita o `TaskCommandTarget` ({ userId, projectId, taskId }) dos comandos porque as regras de acesso
 * são as mesmas: o histórico expõe quem foi atribuído e quando, então uma leitura também precisa da
 * verificação de posse e do mesmo 404 anti-IDOR (OWASP A01).
 */
export class GetTaskHistoryQuery {
  constructor(public readonly target: TaskCommandTarget) {}
}
