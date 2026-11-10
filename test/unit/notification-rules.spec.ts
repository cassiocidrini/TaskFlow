/**
 * Regras de notificação (`decide`) — Módulo 13.4. Função pura: evento + projeção local → decisão.
 *
 * Protege o comportamento que o usuário vê: quem é notificado de quê, que ninguém recebe notificação da própria
 * ação, que a projeção local acompanha o responsável (o `TaskCompleted` não o traz) e que um evento de tarefa que o
 * consumer não conhece não gera notificação com título inventado.
 */
import {
  decide,
  type LocalTask,
} from '../../src/modules/notifications/consumer/notification-rules';
import type { TaskEvent } from '../../src/modules/notifications/consumer/task-event.message';

const OWNER = '11111111-1111-4111-8111-111111111111';
const ANA = '22222222-2222-4222-8222-222222222222';
const BIA = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';
const PROJECT = '55555555-5555-4555-8555-555555555555';

const envelope = {
  eventId: '66666666-6666-4666-8666-666666666666',
  eventVersion: 1,
  occurredAt: '2026-11-10T12:00:00.000Z',
  aggregateId: TASK,
  aggregateVersion: 1,
  projectId: PROJECT,
  actorId: OWNER,
};

const created = (assigneeId?: string): TaskEvent => ({
  ...envelope,
  eventType: 'TaskCreated',
  data: {
    title: 'Conciliar pagamentos',
    ...(assigneeId ? { assigneeId } : {}),
  },
});
const assigned = (assigneeId: string, actorId = OWNER): TaskEvent => ({
  ...envelope,
  actorId,
  eventType: 'TaskAssigned',
  data: { assigneeId },
});
const completed = (actorId = OWNER): TaskEvent => ({
  ...envelope,
  actorId,
  eventType: 'TaskCompleted',
  data: { completedAt: '2026-11-10T12:00:00.000Z' },
});

const local = (assigneeId: string | null): LocalTask => ({
  projectId: PROJECT,
  title: 'Conciliar pagamentos',
  assigneeId,
});

describe('decide (regras de notificação)', () => {
  it('TaskCreated com responsável: registra a tarefa e notifica o responsável', () => {
    expect(decide(created(ANA), null)).toEqual({
      task: local(ANA),
      notification: {
        userId: ANA,
        type: 'TASK_ASSIGNED',
        message: 'Você foi atribuído à tarefa "Conciliar pagamentos"',
      },
    });
  });

  it('TaskCreated sem responsável: só registra a tarefa', () => {
    expect(decide(created(), null)).toEqual({ task: local(null) });
  });

  it('TaskAssigned: atualiza o responsável na projeção local e o notifica', () => {
    const decision = decide(assigned(BIA), local(ANA));

    expect(decision.task).toEqual(local(BIA));
    expect(decision.notification).toMatchObject({
      userId: BIA,
      type: 'TASK_ASSIGNED',
    });
  });

  it('TaskCompleted: notifica o responsável ATUAL (que vem da projeção local, não do evento)', () => {
    expect(decide(completed(), local(ANA))).toEqual({
      notification: {
        userId: ANA,
        type: 'TASK_COMPLETED',
        message: 'A tarefa "Conciliar pagamentos" foi concluída',
      },
    });
  });

  it.each([
    ['atribuir a si mesmo', () => decide(assigned(OWNER), local(null))],
    ['criar já atribuída a si mesmo', () => decide(created(OWNER), null)],
    ['concluir a própria tarefa', () => decide(completed(ANA), local(ANA))],
  ])('ninguém é notificado da própria ação: %s', (_caso, run) => {
    expect(run().notification).toBeUndefined();
  });

  it('TaskCompleted sem responsável: nada a notificar', () => {
    expect(decide(completed(), local(null))).toEqual({});
  });

  it('evento de tarefa que o consumer não conhece (sem TaskCreated): decisão vazia, sem título inventado', () => {
    expect(decide(assigned(ANA), null)).toEqual({});
    expect(decide(completed(), null)).toEqual({});
  });
});
