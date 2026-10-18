import type {
  OpenTaskStatus,
  TaskDomainEvent,
  TaskPriority,
  TaskStatus,
} from '../events/task.events';

/**
 * Violação de regra de negócio do agregado (ex.: concluir uma tarefa já concluída).
 * Erro de DOMÍNIO puro — não conhece HTTP. A tradução para 409/422 acontece na borda (handler).
 */
export class TaskInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskInvariantError';
  }
}

/**
 * Agregado Task (DDD + Event Sourcing).
 *
 * - Estado NUNCA é setado diretamente: só muda via apply(evento).
 * - fromHistory() reconstrói o estado aplicando os eventos persistidos em ordem (replay).
 * - Comandos de domínio validam invariantes e, se tudo ok, "levantam" novos eventos pendentes.
 * - Zero dependências de framework/banco: testável em milissegundos, sem mocks.
 */
export class TaskAggregate {
  private _id!: string;
  private _projectId!: string;
  private _title!: string;
  private _priority!: TaskPriority;
  private _status: TaskStatus = 'PENDING';
  private _assigneeId?: string;
  private _dueDate?: string;
  private _completedAt?: string;

  /** Quantos eventos já estão PERSISTIDOS — é o expectedVersion do próximo append. */
  private _version = 0;
  private _pendingEvents: TaskDomainEvent[] = [];

  private constructor() {}

  // ============================================================
  // Reidratação
  // ============================================================

  static fromHistory(history: readonly TaskDomainEvent[]): TaskAggregate {
    if (history.length === 0) {
      throw new TaskInvariantError('Histórico vazio: a tarefa não existe');
    }
    if (history[0].type !== 'TaskCreated') {
      throw new TaskInvariantError('Histórico corrompido: o primeiro evento deve ser TaskCreated');
    }

    const task = new TaskAggregate();
    for (const event of history) {
      task.apply(event);
    }
    task._version = history.length;
    return task;
  }

  // ============================================================
  // Comandos de domínio (validam invariantes → levantam eventos)
  // ============================================================

  assign(assigneeId: string): void {
    this.ensureNotDone('reatribuir');
    if (this._assigneeId === assigneeId) return; // idempotente: nada mudou, nenhum evento

    this.raise({ type: 'TaskAssigned', data: { taskId: this._id, assigneeId } });
  }

  changeStatus(to: OpenTaskStatus): void {
    this.ensureNotDone('mudar o status de');
    const from = this._status as OpenTaskStatus; // seguro: ensureNotDone garantiu que não é DONE
    if (from === to) return; // idempotente

    this.raise({ type: 'TaskStatusChanged', data: { taskId: this._id, from, to } });
  }

  complete(now: Date): void {
    this.ensureNotDone('concluir');

    this.raise({ type: 'TaskCompleted', data: { taskId: this._id, completedAt: now.toISOString() } });
  }

  /** Entrega os eventos novos para o repositório persistir — e limpa a fila. */
  pullPendingEvents(): TaskDomainEvent[] {
    const events = this._pendingEvents;
    this._pendingEvents = [];
    return events;
  }

  // ============================================================
  // Leitura de estado
  // ============================================================

  get id() { return this._id; }
  get projectId() { return this._projectId; }
  get title() { return this._title; }
  get priority() { return this._priority; }
  get status() { return this._status; }
  get assigneeId() { return this._assigneeId; }
  get dueDate() { return this._dueDate; }
  get completedAt() { return this._completedAt; }
  get version() { return this._version; }

  // ============================================================
  // Internos
  // ============================================================

  private ensureNotDone(acao: string): void {
    if (this._status === 'DONE') {
      throw new TaskInvariantError(`Não é possível ${acao} uma tarefa concluída`);
    }
  }

  private raise(event: TaskDomainEvent): void {
    this.apply(event); // o estado em memória já reflete o evento novo
    this._pendingEvents.push(event);
  }

  /** ÚNICO lugar onde o estado muda. O switch é exaustivo: um evento novo sem case não compila. */
  private apply(event: TaskDomainEvent): void {
    switch (event.type) {
      case 'TaskCreated':
        this._id = event.data.taskId;
        this._projectId = event.data.projectId;
        this._title = event.data.title;
        this._priority = event.data.priority;
        this._assigneeId = event.data.assigneeId;
        this._dueDate = event.data.dueDate;
        this._status = 'PENDING';
        return;
      case 'TaskAssigned':
        this._assigneeId = event.data.assigneeId;
        return;
      case 'TaskStatusChanged':
        this._status = event.data.to;
        return;
      case 'TaskCompleted':
        this._status = 'DONE';
        this._completedAt = event.data.completedAt;
        return;
      default: {
        const _exhaustive: never = event;
        throw new Error(`Evento desconhecido: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }
}
