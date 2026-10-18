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

// ============================================================
// Eventos do ciclo de vida da tarefa
// ============================================================

/** Status "abertos" — DONE só se alcança via TaskCompleted (que é terminal). */
export type OpenTaskStatus = 'PENDING' | 'IN_PROGRESS';
export type TaskStatus = OpenTaskStatus | 'DONE';

export interface TaskAssignedData {
  taskId: string;
  assigneeId: string;
}

export interface TaskStatusChangedData {
  taskId: string;
  from: OpenTaskStatus;
  to: OpenTaskStatus;
}

export interface TaskCompletedData {
  taskId: string;
  /** ISO 8601 */
  completedAt: string;
}

export class TaskAssignedEvent implements TaskAssignedData {
  readonly taskId: string;
  readonly assigneeId: string;

  constructor(data: TaskAssignedData) {
    this.taskId = data.taskId;
    this.assigneeId = data.assigneeId;
  }
}

export class TaskStatusChangedEvent implements TaskStatusChangedData {
  readonly taskId: string;
  readonly from: OpenTaskStatus;
  readonly to: OpenTaskStatus;

  constructor(data: TaskStatusChangedData) {
    this.taskId = data.taskId;
    this.from = data.from;
    this.to = data.to;
  }
}

export class TaskCompletedEvent implements TaskCompletedData {
  readonly taskId: string;
  readonly completedAt: string;

  constructor(data: TaskCompletedData) {
    this.taskId = data.taskId;
    this.completedAt = data.completedAt;
  }
}

/**
 * União discriminada de TODOS os eventos da tarefa, no formato em que vivem no Event Store
 * (event_type + payload). O campo `type` permite ao TypeScript estreitar o `data` em cada `case`.
 */
export type TaskDomainEvent =
  | { type: 'TaskCreated'; data: TaskCreatedData }
  | { type: 'TaskAssigned'; data: TaskAssignedData }
  | { type: 'TaskStatusChanged'; data: TaskStatusChangedData }
  | { type: 'TaskCompleted'; data: TaskCompletedData };
