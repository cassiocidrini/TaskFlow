// Tipo de DOMÍNIO — não importamos do @prisma/client para o domínio não depender do ORM.
// O enum do Prisma tem o mesmo formato, então os dois são intercambiáveis (tipagem estrutural).
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TaskCreatedData {
  taskId: string;
  projectId: string;
  title: string;
  priority: TaskPriority;
  assigneeId?: string;
  /** ISO 8601 — eventos viajam serializados (JSON no Event Store), então nada de Date aqui */
  dueDate?: string;
}

/**
 * Construtor com objeto NOMEADO (e não parâmetros posicionais):
 * com vários campos do tipo string, trocar a ordem dos argumentos compila sem erro
 * e corrompe o Event Store para sempre — bug que já aconteceu neste projeto.
 */
export class TaskCreatedEvent implements TaskCreatedData {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly priority: TaskPriority;
  readonly assigneeId?: string;
  readonly dueDate?: string;

  constructor(data: TaskCreatedData) {
    this.taskId = data.taskId;
    this.projectId = data.projectId;
    this.title = data.title;
    this.priority = data.priority;
    this.assigneeId = data.assigneeId;
    this.dueDate = data.dueDate;
  }
}

export class TaskCompletedEvent {
  constructor(
    public readonly taskId: string,
    public readonly completedAt: string,
  ) {}
}
