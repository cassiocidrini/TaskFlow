/**
 * Expand do prazo contra PostgreSQL REAL (Testcontainers) — Módulo 14.4a.
 *
 * Protege as duas partes do expand que só existem no banco:
 * - o **upcaster** na leitura de verdade: um `TaskCreated` v1 GRAVADO (com `dueDate`, e também um legado sem
 *   envelope) é lido pelo repositório como v2, com `timezone: null`, e a linha no banco continua intacta (o Event
 *   Store é append-only: a leitura converte, nada é reescrito);
 * - o **backfill**: o SQL da própria migração copia `due_date` → `due_at` nas linhas antigas, sem inventar fuso, sem
 *   tocar no que já tinha `due_at`, e pode rodar de novo (idempotente) — é o que o contract (14.4b) vai repetir para as
 *   linhas criadas pela versão anterior da API no meio do deploy.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { EventStoreService } from '../../src/events/event-store.service';
import { EventSourcedTaskRepository } from '../../src/modules/tasks/infrastructure/event-sourced-task.repository';
import { startTestDatabase, TestDatabase } from './support/test-database';

const BACKFILL_SQL = (() => {
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const folder = readdirSync(dir).find((name) =>
    name.endsWith('_tasks_read_due_backfill'),
  );
  if (!folder) throw new Error('migração de backfill não encontrada');
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf8');
})();

describe('Expand do prazo (integração)', () => {
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

  describe('backfill de tasks_read', () => {
    const at = new Date('2026-12-31T23:59:59.000Z');
    const newer = new Date('2027-01-15T12:00:00.000Z');

    beforeEach(async () => {
      await prisma.$executeRawUnsafe('TRUNCATE TABLE "tasks_read"');
      await prisma.taskRead.createMany({
        data: [
          // Linha antiga: só a coluna velha
          { id: randomUUID(), projectId: 'p', title: 'antiga', dueDate: at },
          // Já no formato novo (gravada pela projeção nova): não pode ser tocada
          {
            id: randomUUID(),
            projectId: 'p',
            title: 'nova',
            dueDate: newer,
            dueAt: newer,
            dueTimezone: 'Europe/Lisbon',
          },
          // Sem prazo
          { id: randomUUID(), projectId: 'p', title: 'sem prazo' },
        ],
      });
    });

    it('copia due_date → due_at nas antigas, sem inventar fuso e sem tocar nas novas', async () => {
      await prisma.$executeRawUnsafe(BACKFILL_SQL);

      const rows = await prisma.taskRead.findMany({
        orderBy: { title: 'asc' },
      });
      const byTitle = Object.fromEntries(rows.map((r) => [r.title, r]));
      expect(byTitle.antiga).toMatchObject({ dueAt: at, dueTimezone: null });
      expect(byTitle.nova).toMatchObject({
        dueAt: newer,
        dueTimezone: 'Europe/Lisbon',
      });
      expect(byTitle['sem prazo']).toMatchObject({
        dueAt: null,
        dueTimezone: null,
      });
    });

    it('idempotente: rodar de novo não muda nada (o contract vai repeti-lo)', async () => {
      await prisma.$executeRawUnsafe(BACKFILL_SQL);
      const before = await prisma.taskRead.findMany({
        orderBy: { title: 'asc' },
      });

      const changed = await prisma.$executeRawUnsafe(BACKFILL_SQL);

      expect(changed).toBe(0);
      expect(
        await prisma.taskRead.findMany({ orderBy: { title: 'asc' } }),
      ).toEqual(before);
    });
  });
});
