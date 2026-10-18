/*
 * Eventos de domínio da tarefa — a FONTE DA VERDADE do Event Sourcing.
 *
 * Um evento é um FATO que já aconteceu: nome no passado (`TaskCompleted`, não `CompleteTask`), imutável
 * (`readonly`) e gravado para sempre no Event Store (append-only). O estado atual de uma tarefa é só a
 * consequência de aplicar esses fatos em ordem.
 *
 * Cada evento aparece em DUAS formas, cada uma com um papel:
 * - **`XData` (interface):** o payload que vai para o Event Store (JSON) e para a união `TaskDomainEvent`
 *   usada pelo agregado;
 * - **`XEvent` (classe):** o que trafega no `EventBus` do NestJS, que roteia para os `@EventsHandler`
 *   PELA CLASSE do objeto publicado — por isso precisa existir em runtime.
 *
 * Datas são `string` ISO 8601, e não `Date`: eventos são mensagens serializadas, e um `Date` vira texto no
 * `JSON.stringify` e não volta sozinho a ser `Date`. A conversão acontece só na borda com o banco.
 *
 * Mudar o FORMATO de um evento já gravado exige cuidado: eventos antigos continuam no store com o formato
 * antigo (versionamento/*upcasting* — limitação documentada no Módulo 05).
 */

/**
 * Tipo de DOMÍNIO — não importamos do `@prisma/client` para o domínio não depender do ORM.
 * O enum do Prisma tem o mesmo formato, então os dois são intercambiáveis (tipagem estrutural).
 */
export type TaskPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export interface TaskCreatedData {
  taskId: string;
  projectId: string;
  title: string;
  /** Calculada no servidor pela Strategy de prioridade, no momento da criação. */
  priority: TaskPriority;
  assigneeId?: string;
  /** ISO 8601 — eventos viajam serializados (JSON no Event Store), então nada de Date aqui */
  dueDate?: string;
}

/**
 * Nascimento da tarefa: o primeiro evento de todo stream (o agregado rejeita um histórico que não comece por ele).
 *
 * Construtor com objeto NOMEADO (e não parâmetros posicionais): com vários campos do tipo string, trocar a
 * ordem dos argumentos compila sem erro e corrompe o Event Store para sempre — bug que já aconteceu neste projeto.
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

/**
 * Status "abertos". `DONE` só se alcança via `TaskCompleted` (terminal). Separar os tipos faz o COMPILADOR
 * impedir um `changeStatus('DONE')` — a regra "um caminho só para concluir" vale antes mesmo de rodar.
 */
export type OpenTaskStatus = 'PENDING' | 'IN_PROGRESS';
export type TaskStatus = OpenTaskStatus | 'DONE';

export interface TaskAssignedData {
  taskId: string;
  assigneeId: string;
}

/** Guarda a ORIGEM e o DESTINO: o histórico conta a trajetória, não só o resultado. */
export interface TaskStatusChangedData {
  taskId: string;
  from: OpenTaskStatus;
  to: OpenTaskStatus;
}

export interface TaskCompletedData {
  taskId: string;
  /** ISO 8601 — o instante vem da borda (handler), não de dentro do agregado */
  completedAt: string;
}

/** Responsável (re)atribuído. Só é gerado quando o responsável MUDA (comando idempotente). */
export class TaskAssignedEvent implements TaskAssignedData {
  readonly taskId: string;
  readonly assigneeId: string;

  constructor(data: TaskAssignedData) {
    this.taskId = data.taskId;
    this.assigneeId = data.assigneeId;
  }
}

/** Mudança entre status abertos. Só é gerado quando o status MUDA. */
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

/** Conclusão — terminal: depois dele, o agregado rejeita qualquer novo comando (409 na API). */
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
 * (`event_type` + `payload`). O campo `type` permite ao TypeScript estreitar o `data` em cada `case` —
 * e os `switch` exaustivos (`never`) do agregado e do `toBusEvent` fazem um evento novo sem tratamento
 * deixar de COMPILAR.
 */
export type TaskDomainEvent =
  | { type: 'TaskCreated'; data: TaskCreatedData }
  | { type: 'TaskAssigned'; data: TaskAssignedData }
  | { type: 'TaskStatusChanged'; data: TaskStatusChangedData }
  | { type: 'TaskCompleted'; data: TaskCompletedData };
