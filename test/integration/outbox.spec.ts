/**
 * Transactional Outbox contra PostgreSQL REAL (Testcontainers) — Módulo 13.2.
 *
 * A propriedade protegida é a ATOMICIDADE entre o Event Store e a outbox: ou o evento e a sua mensagem existem
 * juntos, ou nenhum dos dois. É isso que elimina o dual-write, e só um banco real prova:
 * - sucesso: uma linha na outbox por evento, com o MESMO `eventId` do envelope, ordem de `id` = ordem de versão e
 *   o mesmo instante em `events.created_at` e no `occurredAt` publicado;
 * - conflito de versão (o 409): NENHUMA linha nem em `events` nem em `outbox`, inclusive com 10 gravações
 *   simultâneas (só a vencedora gera mensagem);
 * - mapper que devolve `null` (evento interno) e store sem mapper: evento gravado, nada na outbox;
 * - de ponta a ponta pelo repositório real: o evento de integração leva o `projectId` do agregado;
 * - o índice parcial das pendentes existe com o predicado certo (o relay da 13.3 depende dele).
 */
import { PrismaClient } from '@prisma/client';
import {
  ConcurrencyConflictError,
  DomainEvent,
  EventStoreService,
} from '../../src/events/event-store.service';
import type { OutboxMapper } from '../../src/events/outbox';
import { TaskAggregate } from '../../src/modules/tasks/domain/task.aggregate';
import { EventSourcedTaskRepository } from '../../src/modules/tasks/infrastructure/event-sourced-task.repository';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('Transactional Outbox (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let eventStore: EventStoreService;

  const evento = (aggregateId: string, eventType: string): DomainEvent => ({
    aggregateId,
    aggregateType: 'Task',
    eventType,
    payload: { taskId: aggregateId },
    schemaVersion: 1,
  });
  const ator = { actorId: 'user-1' };

  /** Mapper mínimo: deixa visível no payload o que o Event Store entregou ao mapper */
  const mapper: OutboxMapper = ({
    event,
    metadata,
    aggregateVersion,
    recordedAt,
  }) => ({
    topic: 'taskflow.task-events.v1',
    key: event.aggregateId,
    eventType: event.eventType,
    payload: {
      eventId: metadata.eventId,
      aggregateVersion,
      occurredAt: recordedAt.toISOString(),
    },
  });
  const comOutbox = { toOutbox: mapper };

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    eventStore = new EventStoreService(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "events", "outbox" RESTART IDENTITY',
    );
  });

  it('deve gravar uma mensagem por evento, com o mesmo eventId, na ordem das versões', async () => {
    const { metadata } = await eventStore.appendMany(
      [
        evento('task-1', 'TaskCreated'),
        evento('task-1', 'TaskAssigned'),
        evento('task-1', 'TaskCompleted'),
      ],
      0,
      ator,
      comOutbox,
    );

    const outbox = await prisma.outboxMessage.findMany({
      orderBy: { id: 'asc' },
    });
    expect(
      outbox.map((m) => [m.eventType, m.messageKey, m.publishedAt, m.attempts]),
    ).toEqual([
      ['TaskCreated', 'task-1', null, 0],
      ['TaskAssigned', 'task-1', null, 0],
      ['TaskCompleted', 'task-1', null, 0],
    ]);
    expect(outbox.map((m) => m.eventId)).toEqual(
      metadata.map((m) => m.eventId),
    );
    expect(
      outbox.map(
        (m) => (m.payload as { aggregateVersion: number }).aggregateVersion,
      ),
    ).toEqual([1, 2, 3]);
  });

  it('deve usar o MESMO instante em events.created_at e no occurredAt da mensagem', async () => {
    await eventStore.append(
      evento('task-1', 'TaskCreated'),
      0,
      ator,
      comOutbox,
    );

    const [event] = await eventStore.loadEvents('task-1');
    const [message] = await prisma.outboxMessage.findMany();
    expect((message.payload as { occurredAt: string }).occurredAt).toBe(
      event.createdAt.toISOString(),
    );
    expect(message.createdAt).toEqual(event.createdAt);
  });

  it('conflito de versão: NENHUMA linha em events nem em outbox (sem dual-write)', async () => {
    await eventStore.append(
      evento('task-1', 'TaskCreated'),
      0,
      ator,
      comOutbox,
    );
    await eventStore.append(
      evento('task-1', 'TaskAssigned'),
      1,
      ator,
      comOutbox,
    ); // ocupa a versão 2

    // Lote desatualizado: v2 conflita; v3 e as duas mensagens não podem entrar sozinhas
    await expect(
      eventStore.appendMany(
        [
          evento('task-1', 'TaskStatusChanged'),
          evento('task-1', 'TaskCompleted'),
        ],
        1,
        ator,
        comOutbox,
      ),
    ).rejects.toThrow(ConcurrencyConflictError);

    expect(await prisma.event.count()).toBe(2);
    expect(
      (await prisma.outboxMessage.findMany({ orderBy: { id: 'asc' } })).map(
        (m) => m.eventType,
      ),
    ).toEqual(['TaskCreated', 'TaskAssigned']);
  });

  it('10 gravações simultâneas na mesma versão: só a vencedora gera mensagem', async () => {
    await eventStore.append(
      evento('task-1', 'TaskCreated'),
      0,
      ator,
      comOutbox,
    );

    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        eventStore.append(evento('task-1', 'TaskAssigned'), 1, ator, comOutbox),
      ),
    );

    const vencedora = resultados.find((r) => r.status === 'fulfilled');
    const conflitos = resultados.filter(
      (r) =>
        r.status === 'rejected' && r.reason instanceof ConcurrencyConflictError,
    );
    expect(conflitos).toHaveLength(9);

    const mensagens = await prisma.outboxMessage.findMany({
      where: { eventType: 'TaskAssigned' },
    });
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0].eventId).toBe(
      (vencedora as PromiseFulfilledResult<{ metadata: { eventId: string }[] }>)
        .value.metadata[0].eventId,
    );
  });

  it('mapper devolvendo null (evento interno) e store sem mapper: evento gravado, outbox vazia', async () => {
    await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator, {
      toOutbox: () => null,
    });
    await eventStore.append(evento('task-2', 'TaskCreated'), 0, ator);

    expect(await prisma.event.count()).toBe(2);
    expect(await prisma.outboxMessage.count()).toBe(0);
  });

  it('pelo repositório real: o evento de integração leva o projectId do agregado e a chave = taskId', async () => {
    const repository = new EventSourcedTaskRepository(eventStore);
    // Tarefa já existente (v1) carregada do banco, como faria o TaskCommandRunner
    await eventStore.append(
      {
        aggregateId: 'task-9',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: {
          taskId: 'task-9',
          projectId: 'proj-9',
          title: 'Tarefa',
          priority: 'LOW',
        },
        schemaVersion: 1,
      },
      0,
      ator,
    );
    const task = (await repository.load('task-9')) as TaskAggregate;
    task.complete(new Date('2026-11-10T12:00:00.000Z'));

    await repository.save(task, { actorId: 'user-9' });

    const [message] = await prisma.outboxMessage.findMany();
    expect(message.messageKey).toBe('task-9');
    expect(message.payload).toMatchObject({
      eventType: 'TaskCompleted',
      aggregateId: 'task-9',
      aggregateVersion: 2,
      projectId: 'proj-9', // o TaskCompleted de domínio não tem projectId
      actorId: 'user-9',
      data: { completedAt: '2026-11-10T12:00:00.000Z' },
    });
  });

  it('o índice parcial das pendentes existe e cobre só published_at IS NULL', async () => {
    const [index] = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'outbox' AND indexname = 'outbox_pending_idx'`;

    expect(index.indexdef).toMatch(/WHERE \(published_at IS NULL\)/);
  });
});
