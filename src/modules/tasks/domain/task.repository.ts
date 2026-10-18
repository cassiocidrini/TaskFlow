import type { TaskDomainEvent } from '../events/task.events';
import type { TaskAggregate } from './task.aggregate';

/**
 * Contrato (port) de persistência do agregado Task — Repository Pattern.
 *
 * É uma abstract class (e não interface) porque interfaces somem na compilação;
 * a classe abstrata existe em runtime e serve TAMBÉM como token de injeção do Nest:
 *   { provide: TaskRepository, useClass: EventSourcedTaskRepository }
 *
 * O domínio depende DESTE contrato; a implementação (Prisma/Event Store) vive em infrastructure/.
 */
export abstract class TaskRepository {
  /** Reidrata o agregado a partir do histórico. `null` se a tarefa não existe. */
  abstract load(taskId: string): Promise<TaskAggregate | null>;

  /**
   * Persiste os eventos pendentes do agregado com concorrência otimista (expectedVersion = task.version).
   * Retorna os eventos gravados — o handler os publica no EventBus para atualizar as projeções.
   *
   * Uma instância de agregado vale para UM comando (load → comando → save). Reutilizá-la depois do
   * save falha com 409 de propósito: a versão em memória ficou para trás (fail-safe).
   *
   * @throws ConcurrencyConflictError se outra requisição gravou no agregado depois do load.
   */
  abstract save(task: TaskAggregate): Promise<TaskDomainEvent[]>;
}
