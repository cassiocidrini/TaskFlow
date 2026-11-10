/**
 * Replay do Event Store pela outbox, contra PostgreSQL REAL — Módulo 13.6b.
 *
 * Protege:
 * - o replay grava o histórico da tarefa na outbox em ordem de versão, com `replay = true` e os MESMOS `eventId`s que
 *   a API gravou; rodar de novo republica (o UNIQUE de `event_id` agora é parcial, só para as linhas da API);
 * - a API continua sem poder gravar o mesmo evento duas vezes;
 * - o histórico inteiro é percorrido em lotes, sem pular nem repetir tarefa;
 * - evento LEGADO (sem envelope) sai com `eventId` = id da linha;
 * - **o lock por agregado:** com o lock de uma tarefa preso, a gravação da API E o replay dessa tarefa ESPERAM.
 *   É o que impede o replay de intercalar com a API e inverter a ordem por tarefa na outbox.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { lockAggregateForOutbox } from '../../src/events/aggregate-lock';
import { EventStoreService } from '../../src/events/event-store.service';
import { TaskAggregate } from '../../src/modules/tasks/domain/task.aggregate';
import { TASK_EVENT_SCHEMA_VERSIONS } from '../../src/modules/tasks/events/task.events';
import { toTaskOutboxMessage } from '../../src/modules/tasks/events/task.integration-events';
import { EventSourcedTaskRepository } from '../../src/modules/tasks/infrastructure/event-sourced-task.repository';
import { TaskEventReplayer } from '../../src/replay/task-event-replayer';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('Replay do Event Store (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let eventStore: EventStoreService;
  let repository: EventSourcedTaskRepository;
  let replayer: TaskEventReplayer;

  const OWNER = randomUUID();
  const ANA = randomUUID();
  const PROJECT = randomUUID();

  /** Tarefa criada pelo caminho do `CreateTaskHandler` (com outbox) */
  const createTask = async (): Promise<string> => {
    const taskId = randomUUID();
    const data = {
      taskId,
      projectId: PROJECT,
      title: 'Conciliar pagamentos',
      priority: 'MEDIUM' as const,
    };
    await eventStore.append(
      {
        aggregateId: taskId,
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: { ...data },
        schemaVersion: TASK_EVENT_SCHEMA_VERSIONS.TaskCreated,
      },
      0,
      { actorId: OWNER },
      {
        toOutbox: (r) =>
          toTaskOutboxMessage({ type: 'TaskCreated', data }, r, PROJECT),
      },
    );
    return taskId;
  };
  const onTask = async (taskId: string, act: (t: TaskAggregate) => void) => {
    const task = (await repository.load(taskId)) as TaskAggregate;
    act(task);
    await repository.save(task, { actorId: OWNER });
  };

  /** Prende o lock de escrita da tarefa numa transação aberta, até `release()` */
  const holdLock = async (taskId: string) => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => (acquired = resolve));
    const transaction = prisma.$transaction(
      async (tx) => {
        await lockAggregateForOutbox(tx, taskId);
        acquired();
        await released;
      },
      { timeout: 10_000 },
    );
    await locked;
    return async () => {
      release();
      await transaction;
    };
  };

  /** A promessa ainda está pendente depois de `ms`? */
  const stillPendingAfter = async (promise: Promise<unknown>, ms: number) => {
    const marker = Symbol('pendente');
    const winner = await Promise.race([
      promise.then(() => 'terminou'),
      new Promise((resolve) => setTimeout(() => resolve(marker), ms)),
    ]);
    return winner === marker;
  };

  const outboxOf = (taskId: string) =>
    prisma.outboxMessage.findMany({
      where: { messageKey: taskId },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    eventStore = new EventStoreService(prisma as never);
    repository = new EventSourcedTaskRepository(eventStore);
    replayer = new TaskEventReplayer(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "events", "outbox" RESTART IDENTITY',
    );
  });

  it('replay de uma tarefa: o histórico em ordem de versão, replay = true, os mesmos eventIds; de novo, republica', async () => {
    const taskId = await createTask();
    await onTask(taskId, (t) => t.assign(ANA));
    await onTask(taskId, (t) => t.complete(new Date()));
    const fromApi = (await outboxOf(taskId)).map((m) => m.eventId);

    await expect(replayer.replay({ aggregateId: taskId })).resolves.toEqual({
      aggregates: 1,
      messages: 3,
    });
    await replayer.replay({ aggregateId: taskId }); // 2ª vez: o UNIQUE parcial deixa

    const rows = await outboxOf(taskId);
    expect(rows.map((m) => [m.eventType, m.replay])).toEqual([
      ['TaskCreated', false],
      ['TaskAssigned', false],
      ['TaskCompleted', false],
      ['TaskCreated', true],
      ['TaskAssigned', true],
      ['TaskCompleted', true],
      ['TaskCreated', true],
      ['TaskAssigned', true],
      ['TaskCompleted', true],
    ]);
    const replayed = rows.filter((m) => m.replay);
    expect(replayed.map((m) => m.eventId)).toEqual([...fromApi, ...fromApi]);
    expect(
      replayed.map(
        (m) => (m.payload as { aggregateVersion: number }).aggregateVersion,
      ),
    ).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('a API continua sem poder gravar o mesmo evento duas vezes (UNIQUE parcial)', async () => {
    const taskId = await createTask();
    const [apiRow] = await outboxOf(taskId);

    await expect(
      prisma.outboxMessage.create({
        data: {
          ...apiRow,
          id: undefined,
          payload: apiRow.payload as object,
          traceContext: undefined,
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });

  it('histórico inteiro em lotes de 2: as 5 tarefas, cada uma uma vez só', async () => {
    const tasks = await Promise.all(
      Array.from({ length: 5 }, () => createTask()),
    );

    await expect(replayer.replay({ batchSize: 2 })).resolves.toEqual({
      aggregates: 5,
      messages: 5,
    });
    const replayed = await prisma.outboxMessage.findMany({
      where: { replay: true },
    });
    expect(replayed.map((m) => m.messageKey).sort()).toEqual([...tasks].sort());
  });

  it('evento LEGADO (sem envelope): eventId = id da linha em events', async () => {
    const taskId = randomUUID();
    const legacy = await prisma.event.create({
      data: {
        aggregateId: taskId,
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: {
          taskId,
          projectId: PROJECT,
          title: 'Antiga',
          priority: 'LOW',
        },
        metadata: {}, // gravado antes do envelope existir
        version: 1,
      },
    });

    await replayer.replay({ aggregateId: taskId });

    const [message] = await outboxOf(taskId);
    expect(message.eventId).toBe(legacy.id);
  });

  it('com o lock da tarefa preso, a gravação da API ESPERA; solto o lock, ela segue', async () => {
    const taskId = await createTask();
    const release = await holdLock(taskId);

    const apiWrite = onTask(taskId, (t) => t.assign(ANA));
    expect(await stillPendingAfter(apiWrite, 300)).toBe(true);

    await release();
    await apiWrite;
    expect((await outboxOf(taskId)).map((m) => m.eventType)).toEqual([
      'TaskCreated',
      'TaskAssigned',
    ]);
  });

  it('com o lock da tarefa preso, o replay dela também ESPERA', async () => {
    const taskId = await createTask();
    const release = await holdLock(taskId);

    const replay = replayer.replay({ aggregateId: taskId });
    expect(await stillPendingAfter(replay, 300)).toBe(true);

    await release();
    await expect(replay).resolves.toEqual({ aggregates: 1, messages: 1 });
  });

  it('o lock de uma tarefa não segura outra', async () => {
    const locked = await createTask();
    const other = await createTask();
    const release = await holdLock(locked);

    await onTask(other, (t) => t.assign(ANA)); // não espera

    await release();
    expect((await outboxOf(other)).map((m) => m.eventType)).toEqual([
      'TaskCreated',
      'TaskAssigned',
    ]);
  });
});
