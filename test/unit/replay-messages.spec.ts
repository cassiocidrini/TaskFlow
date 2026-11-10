/**
 * Tradução do histórico para mensagens de replay (`toReplayMessages`) — Módulo 13.6b.
 *
 * Protege o contrato do que o replay publica:
 * - o envelope é o da GRAVAÇÃO original (eventId, autor, instante, versão), não o de agora: a guarda de versão das
 *   projeções e a idempotência dos consumers dependem disso;
 * - evento LEGADO (sem envelope): `eventId` = id da linha (estável entre execuções) e autor = UUID nulo;
 * - o `projectId` de cada tarefa vem do `TaskCreated` dela, inclusive com várias tarefas no mesmo lote;
 * - toda linha sai com `replay = true`;
 * - stream sem `TaskCreated` na frente falha alto, em vez de publicar eventos sem projeto.
 */
import type { Event as StoredEvent } from '@prisma/client';
import { UNKNOWN_ACTOR_ID } from '../../src/modules/tasks/events/task.integration-events';
import { toReplayMessages } from '../../src/replay/replay-messages';

const NOW = new Date('2026-11-10T20:00:00.000Z');
const ANA = 'c5afce1e-dbd3-4606-a69f-cc930471cef8';

const row = (
  aggregateId: string,
  version: number,
  eventType: string,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown> = {
    eventId: `e0000000-0000-4000-8000-00000000000${version}`,
    actorId: ANA,
    correlationId: 'corr-1',
    schemaVersion: 1,
  },
): StoredEvent => ({
  id: `a0000000-0000-4000-8000-${aggregateId.slice(-4)}0000000${version}`,
  aggregateId,
  aggregateType: 'Task',
  eventType,
  payload: { taskId: aggregateId, ...payload },
  metadata: metadata as StoredEvent['metadata'],
  version,
  createdAt: new Date(`2026-11-0${version}T10:00:00.000Z`),
});

const created = (
  taskId: string,
  projectId: string,
  metadata?: Record<string, unknown>,
) =>
  row(
    taskId,
    1,
    'TaskCreated',
    { projectId, title: 'Conciliar', priority: 'MEDIUM' },
    metadata,
  );

const TASK_A = '370b268e-18ba-444c-ae17-2716b026aaaa';
const TASK_B = '370b268e-18ba-444c-ae17-2716b026bbbb';
const PROJECT_A = 'bab4a090-6a9f-41eb-b3f6-b0302ee4aaaa';
const PROJECT_B = 'bab4a090-6a9f-41eb-b3f6-b0302ee4bbbb';

describe('toReplayMessages', () => {
  it('envelope da gravação original, replay = true, na ordem recebida', () => {
    const [first, second] = toReplayMessages(
      [
        created(TASK_A, PROJECT_A),
        row(TASK_A, 2, 'TaskAssigned', { assigneeId: ANA }),
      ],
      NOW,
    );

    expect(first).toMatchObject({
      eventId: 'e0000000-0000-4000-8000-000000000001',
      messageKey: TASK_A,
      eventType: 'TaskCreated',
      replay: true,
      createdAt: NOW, // quando entrou na outbox
    });
    expect(second.payload).toMatchObject({
      eventId: 'e0000000-0000-4000-8000-000000000002',
      aggregateVersion: 2, // a versão ORIGINAL: é ela que a guarda das projeções compara
      occurredAt: '2026-11-02T10:00:00.000Z', // o instante ORIGINAL
      projectId: PROJECT_A,
      actorId: ANA,
      correlationId: 'corr-1',
    });
  });

  it('evento LEGADO (sem envelope): eventId = id da linha, autor = UUID nulo', () => {
    const legacy = created(TASK_A, PROJECT_A, {});
    const [message] = toReplayMessages([legacy], NOW);

    expect(message.eventId).toBe(legacy.id);
    expect(message.payload).toMatchObject({
      eventId: legacy.id,
      actorId: UNKNOWN_ACTOR_ID,
    });
    expect(message.payload).not.toHaveProperty('correlationId');
  });

  it('o mesmo histórico, duas vezes: os mesmos eventIds (a idempotência dos consumers continua valendo)', () => {
    const history = [
      created(TASK_A, PROJECT_A, {}),
      row(TASK_A, 2, 'TaskAssigned', { assigneeId: ANA }),
    ];

    expect(toReplayMessages(history, NOW).map((m) => m.eventId)).toEqual(
      toReplayMessages(history, new Date()).map((m) => m.eventId),
    );
  });

  it('várias tarefas no lote: cada uma com o projeto do SEU TaskCreated', () => {
    const messages = toReplayMessages(
      [
        created(TASK_A, PROJECT_A),
        row(TASK_A, 2, 'TaskAssigned', { assigneeId: ANA }),
        created(TASK_B, PROJECT_B),
        row(TASK_B, 2, 'TaskCompleted', {
          completedAt: '2026-11-02T10:00:00.000Z',
        }),
      ],
      NOW,
    );

    expect(
      messages.map((m) => [
        m.messageKey,
        (m.payload as { projectId: string }).projectId,
      ]),
    ).toEqual([
      [TASK_A, PROJECT_A],
      [TASK_A, PROJECT_A],
      [TASK_B, PROJECT_B],
      [TASK_B, PROJECT_B],
    ]);
  });

  it('stream sem TaskCreated na frente: falha alto, sem publicar nada', () => {
    expect(() =>
      toReplayMessages(
        [row(TASK_A, 2, 'TaskAssigned', { assigneeId: ANA })],
        NOW,
      ),
    ).toThrow('veio antes do TaskCreated');
  });
});
