/**
 * Upcaster do `TaskCreated` contra PostgreSQL REAL (Testcontainers) — Módulo 14.4.
 *
 * Protege a parte do expand/contract que fica PARA SEMPRE: o `dueDate` saiu da API e do read model, mas os eventos
 * gravados antes da 14.4 continuam no Event Store com ele. Um `TaskCreated` v1 GRAVADO (com envelope, e também um
 * legado sem envelope) é lido pelo repositório como v2, com `timezone: null`, e a linha no banco continua intacta (o
 * Event Store é append-only: a leitura converte, nada é reescrito).
 *
 * (Os testes do backfill da 14.4a saíram na 14.4c: a coluna `due_date` que eles liam foi removida.)
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { EventStoreService } from '../../src/events/event-store.service';
import { EventSourcedTaskRepository } from '../../src/modules/tasks/infrastructure/event-sourced-task.repository';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('Upcaster do TaskCreated (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let repository: EventSourcedTaskRepository;

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    repository = new EventSourcedTaskRepository(
      new EventStoreService(prisma as never),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  /** Um TaskCreated como a API gravava ANTES da 14.4: payload v1 com `dueDate`. */
  const insertV1 = async (metadata: object) => {
    const taskId = randomUUID();
    await prisma.event.create({
      data: {
        aggregateId: taskId,
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        version: 1,
        payload: {
          taskId,
          projectId: randomUUID(),
          title: 'Gravada antes da 14.4',
          priority: 'MEDIUM',
          dueDate: '2026-12-31T23:59:59.000Z',
        },
        metadata,
      },
    });
    return taskId;
  };

  it('evento v1 gravado é lido como v2 (timezone null), e o banco continua com o v1', async () => {
    const taskId = await insertV1({
      eventId: randomUUID(),
      actorId: randomUUID(),
      schemaVersion: 1,
    });

    const task = await repository.load(taskId);

    expect(task?.due).toEqual({
      at: '2026-12-31T23:59:59.000Z',
      timezone: null,
    });
    const [stored] = await prisma.event.findMany({
      where: { aggregateId: taskId },
    });
    expect(stored.payload).toHaveProperty(
      'dueDate',
      '2026-12-31T23:59:59.000Z',
    ); // nada reescrito
    expect(stored.payload).not.toHaveProperty('due');
  });

  it('evento legado, sem envelope (metadata = {}), também é lido como v1', async () => {
    const taskId = await insertV1({});
    expect((await repository.load(taskId))?.due?.timezone).toBeNull();
  });
});
