/*
 * Regras dos relatórios (Módulo 13.6a): dado o estado guardado de uma tarefa e um evento, o novo estado e o DELTA dos
 * contadores do projeto. Funções puras: o handler só aplica o resultado no banco, e os testes cobrem cada transição
 * sem Postgres.
 *
 * Delta, e não "recalcular o projeto": cada evento muda poucas tarefas, e o contador é atualizado por incremento
 * atômico (`SET pending = pending + $delta`), que tarefas do mesmo projeto em partições diferentes podem fazer em
 * paralelo sem perder atualização.
 */
import type { ReportEvent } from './task-event.message';

export type ReportStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE';

/** O que `report_tasks` guarda de uma tarefa. */
export interface ReportTaskState {
  projectId: string;
  status: ReportStatus;
  assigneeId: string | null;
  taskCreatedAt: Date;
}

/** Quanto cada contador de `project_stats` muda. Zero = não muda. */
export interface StatsDelta {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  unassignedOpen: number;
  leadTimeSeconds: number;
}

export type ReportDecision =
  | { kind: 'apply'; next: ReportTaskState; delta: StatsDelta }
  /** Evento de uma tarefa cujo `TaskCreated` este consumer nunca viu (ver {@link decide}). */
  | { kind: 'unknown_task' };

export const ZERO_DELTA: Readonly<StatsDelta> = {
  total: 0,
  pending: 0,
  inProgress: 0,
  done: 0,
  unassignedOpen: 0,
  leadTimeSeconds: 0,
};

/**
 * Próximo estado e delta. A duplicata (versão já aplicada) é barrada ANTES, pelo handler; aqui o evento é sempre novo.
 *
 * `unknown_task`: um evento que não é `TaskCreated` de uma tarefa sem estado guardado. Acontece com tarefas criadas
 * antes da outbox (Módulo 13.2), cujo `TaskCreated` nunca foi publicado. Sem o estado, não há de onde decrementar;
 * aplicar mesmo assim deixaria os contadores errados. Quem corrige é o replay a partir do Event Store (13.6b).
 *
 * O status de ORIGEM vem do estado guardado, não do `from` do evento: a projeção confia no que ela mesma aplicou.
 */
export function decide(
  current: ReportTaskState | null,
  event: ReportEvent,
): ReportDecision {
  if (event.eventType === 'TaskCreated') {
    const unassigned = event.data.assigneeId ? 0 : 1;
    return {
      kind: 'apply',
      next: {
        projectId: event.projectId,
        status: 'PENDING',
        assigneeId: event.data.assigneeId ?? null,
        taskCreatedAt: new Date(event.occurredAt),
      },
      delta: {
        ...ZERO_DELTA,
        total: 1,
        pending: 1,
        unassignedOpen: unassigned,
      },
    };
  }

  if (!current) {
    return { kind: 'unknown_task' };
  }

  switch (event.eventType) {
    case 'TaskAssigned': {
      return {
        kind: 'apply',
        next: { ...current, assigneeId: event.data.assigneeId },
        delta: {
          ...ZERO_DELTA,
          unassignedOpen: isUnassignedOpen(current) ? -1 : 0,
        },
      };
    }
    case 'TaskStatusChanged':
      return {
        kind: 'apply',
        next: { ...current, status: event.data.to },
        delta: moveStatus(current.status, event.data.to),
      };
    case 'TaskCompleted': {
      const leadTime =
        (new Date(event.data.completedAt).getTime() -
          current.taskCreatedAt.getTime()) /
        1000;
      return {
        kind: 'apply',
        next: { ...current, status: 'DONE' },
        delta: {
          ...moveStatus(current.status, 'DONE'),
          // Deixa de ser "aberta sem responsável"
          unassignedOpen: isUnassignedOpen(current) ? -1 : 0,
          // Relógios de máquinas diferentes podem deixar a conclusão "antes" da criação por milissegundos: nunca negativo
          leadTimeSeconds: Math.max(0, leadTime),
        },
      };
    }
  }
}

/** Conta em `unassigned_open`: só tarefa ABERTA sem responsável (o domínio não mexe em tarefa concluída). */
function isUnassignedOpen(task: ReportTaskState): boolean {
  return task.assigneeId === null && task.status !== 'DONE';
}

/** Tira a tarefa do contador de origem e a põe no de destino. */
function moveStatus(from: ReportStatus, to: ReportStatus): StatsDelta {
  const delta = { ...ZERO_DELTA };
  delta[counterOf(from)] -= 1;
  delta[counterOf(to)] += 1;
  return delta;
}

function counterOf(status: ReportStatus): 'pending' | 'inProgress' | 'done' {
  return status === 'PENDING'
    ? 'pending'
    : status === 'IN_PROGRESS'
      ? 'inProgress'
      : 'done';
}
