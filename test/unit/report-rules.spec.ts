/**
 * Regras dos relatórios (`report-rules.ts`) — Módulo 13.6a.
 *
 * Protege o cálculo do DELTA de cada evento, que é o que o consumer soma aos contadores do projeto:
 * - cada transição tira a tarefa do contador de origem e a põe no de destino (o total só muda na criação);
 * - "aberta sem responsável" entra na criação sem responsável e sai na atribuição ou na conclusão, uma vez só;
 * - o status de ORIGEM vem do estado guardado, não do `from` do evento;
 * - lead time = conclusão − criação, nunca negativo;
 * - evento de tarefa sem `TaskCreated` conhecido é `unknown_task` (não dá para decrementar o que nunca foi contado).
 *
 * Invariante conferido no fim: aplicar o ciclo inteiro de uma tarefa soma exatamente "1 tarefa concluída".
 */
import {
  decide,
  type ReportTaskState,
  type StatsDelta,
} from '../../src/modules/reports/consumer/report-rules';
import type { ReportEvent } from '../../src/modules/reports/consumer/task-event.message';

const TASK = '370b268e-18ba-444c-ae17-2716b0269232';
const PROJECT = 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87';
const ANA = 'c5afce1e-dbd3-4606-a69f-cc930471cef8';
const CREATED_AT = '2026-11-10T10:00:00.000Z';

const envelope = (version: number, occurredAt = CREATED_AT) => ({
  eventId: '6f1d4c9e-2b7a-4e0f-9c3d-1a2b3c4d5e6f',
  eventVersion: 1,
  occurredAt,
  aggregateId: TASK,
  aggregateVersion: version,
  projectId: PROJECT,
});

const created = (assigneeId?: string): ReportEvent => ({
  ...envelope(1),
  eventType: 'TaskCreated',
  data: assigneeId ? { assigneeId } : {},
});
const assigned: ReportEvent = {
  ...envelope(2),
  eventType: 'TaskAssigned',
  data: { assigneeId: ANA },
};
const started: ReportEvent = {
  ...envelope(3),
  eventType: 'TaskStatusChanged',
  data: { from: 'PENDING', to: 'IN_PROGRESS' },
};
const completed = (completedAt: string): ReportEvent => ({
  ...envelope(4),
  eventType: 'TaskCompleted',
  data: { completedAt },
});

const state = (overrides: Partial<ReportTaskState> = {}): ReportTaskState => ({
  projectId: PROJECT,
  status: 'PENDING',
  assigneeId: null,
  taskCreatedAt: new Date(CREATED_AT),
  ...overrides,
});

/** Aplica o decide e devolve o delta (falha o teste se não aplicou) */
const deltaOf = (current: ReportTaskState | null, event: ReportEvent) => {
  const decision = decide(current, event);
  if (decision.kind !== 'apply')
    throw new Error(`não aplicou: ${decision.kind}`);
  return decision;
};

/** Só os campos diferentes de zero: o teste mostra o que muda */
const nonZero = (delta: StatsDelta) =>
  Object.fromEntries(Object.entries(delta).filter(([, v]) => v !== 0));

describe('report-rules: decide', () => {
  it('TaskCreated sem responsável: +1 total, +1 pendente, +1 aberta sem responsável', () => {
    const { next, delta } = deltaOf(null, created());

    expect(nonZero(delta)).toEqual({ total: 1, pending: 1, unassignedOpen: 1 });
    expect(next).toEqual(state());
  });

  it('TaskCreated já com responsável: não entra em "aberta sem responsável"', () => {
    const { next, delta } = deltaOf(null, created(ANA));

    expect(nonZero(delta)).toEqual({ total: 1, pending: 1 });
    expect(next.assigneeId).toBe(ANA);
  });

  it('TaskAssigned de tarefa aberta sem responsável: sai de "aberta sem responsável"', () => {
    const { next, delta } = deltaOf(state(), assigned);

    expect(nonZero(delta)).toEqual({ unassignedOpen: -1 });
    expect(next.assigneeId).toBe(ANA);
  });

  it('reatribuição (já tinha responsável): nenhum contador muda', () => {
    expect(
      nonZero(deltaOf(state({ assigneeId: ANA }), assigned).delta),
    ).toEqual({});
  });

  it('TaskStatusChanged: move entre os contadores de status', () => {
    expect(nonZero(deltaOf(state(), started).delta)).toEqual({
      pending: -1,
      inProgress: 1,
    });
  });

  it('o status de ORIGEM vem do estado guardado, não do `from` do evento', () => {
    const back: ReportEvent = {
      ...started,
      data: { from: 'PENDING', to: 'PENDING' }, // `from` mentindo: a tarefa está IN_PROGRESS
    };

    expect(
      nonZero(deltaOf(state({ status: 'IN_PROGRESS' }), back).delta),
    ).toEqual({ inProgress: -1, pending: 1 });
  });

  it('TaskCompleted: sai do status atual, entra em DONE e soma o lead time', () => {
    const { next, delta } = deltaOf(
      state({ status: 'IN_PROGRESS', assigneeId: ANA }),
      completed('2026-11-11T10:00:00.000Z'), // 1 dia depois da criação
    );

    expect(nonZero(delta)).toEqual({
      inProgress: -1,
      done: 1,
      leadTimeSeconds: 86_400,
    });
    expect(next.status).toBe('DONE');
  });

  it('TaskCompleted de tarefa sem responsável: também sai de "aberta sem responsável"', () => {
    expect(
      deltaOf(state(), completed('2026-11-10T11:00:00.000Z')).delta
        .unassignedOpen,
    ).toBe(-1);
  });

  it('lead time nunca negativo (relógios de máquinas diferentes)', () => {
    expect(
      deltaOf(state(), completed('2026-11-10T09:59:59.990Z')).delta
        .leadTimeSeconds,
    ).toBe(0);
  });

  it.each([assigned, started, completed(CREATED_AT)])(
    '$eventType de tarefa sem TaskCreated conhecido: unknown_task',
    (event) => {
      expect(decide(null, event)).toEqual({ kind: 'unknown_task' });
    },
  );

  it('invariante: o ciclo inteiro de uma tarefa soma exatamente "1 tarefa concluída"', () => {
    const events = [
      created(),
      assigned,
      started,
      completed('2026-11-10T12:00:00.000Z'),
    ];
    let current: ReportTaskState | null = null;
    const total: Record<string, number> = {};
    for (const event of events) {
      const { next, delta } = deltaOf(current, event);
      for (const [key, value] of Object.entries(delta)) {
        total[key] = (total[key] ?? 0) + value;
      }
      current = next;
    }

    expect(total).toEqual({
      total: 1,
      pending: 0,
      inProgress: 0,
      done: 1,
      unassignedOpen: 0,
      leadTimeSeconds: 7_200,
    });
  });
});
