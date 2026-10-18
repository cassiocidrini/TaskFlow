/**
 * Projeções do `tasks_read` contra PostgreSQL REAL.
 *
 * Prova o que os testes unitários só afirmam: entrega duplicada → 1 linha; 5 entregas SIMULTÂNEAS → 1 linha e
 * zero erros (`ON CONFLICT DO NOTHING` é atômico); replay completo → mesmo estado final; e o enum do Postgres
 * recusando um status inválido mesmo via SQL direto (o banco como última linha de defesa).
 *
 * Brokers reais (SQS, Kafka) garantem entrega "at-least-once": idempotência não é opcional.
 */
import { Logger } from '@nestjs/common';
import { TaskCreatedHandler } from '../../src/modules/tasks/events/task-created.handler';
import {
  TaskAssignedProjection,
  TaskCompletedProjection,
  TaskStatusChangedProjection,
} from '../../src/modules/tasks/events/task-lifecycle.projections';
import {
  TaskAssignedEvent,
  TaskCompletedEvent,
  TaskCreatedEvent,
  TaskStatusChangedEvent,
} from '../../src/modules/tasks/events/task.events';
import { PrismaService } from '../../src/prisma/prisma.service';
import { startTestDatabase, TestDatabase } from './support/test-database';

/**
 * Prova, contra o Postgres REAL, o que os testes unitários (com mock) só conseguem afirmar:
 * as projeções sobrevivem a entregas duplicadas — a garantia real dos brokers é "at-least-once".
 */
describe('Projeções do tasks_read (integração)', () => {
  let db: TestDatabase;

  // Mesmos handlers de produção, apontando para o banco do container
  let created: TaskCreatedHandler;
  let assigned: TaskAssignedProjection;
  let statusChanged: TaskStatusChangedProjection;
  let completed: TaskCompletedProjection;

  const taskCreated = new TaskCreatedEvent({
    taskId: '11111111-1111-4111-8111-111111111111',
    projectId: '22222222-2222-4222-8222-222222222222',
    title: 'Tarefa de integração',
    priority: 'HIGH',
    dueDate: '2026-12-31T23:59:59.000Z',
  });
  const { taskId } = taskCreated;

  beforeAll(async () => {
    db = await startTestDatabase();
    const prisma = db.prisma as unknown as PrismaService;
    created = new TaskCreatedHandler(prisma);
    assigned = new TaskAssignedProjection(prisma);
    statusChanged = new TaskStatusChangedProjection(prisma);
    completed = new TaskCompletedProjection(prisma);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await db.prisma.taskRead.deleteMany();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined); // silencia o WARN esperado
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ============================================================
  // TaskCreated: INSERT ... ON CONFLICT DO NOTHING
  // ============================================================
  describe('TaskCreated (INSERT idempotente)', () => {
    it('entrega DUPLICADA deve resultar em UMA linha, sem erro', async () => {
      await created.handle(taskCreated);
      await expect(created.handle(taskCreated)).resolves.toBeUndefined();

      expect(await db.prisma.taskRead.count()).toBe(1);
    });

    it('entregas SIMULTÂNEAS do mesmo evento: uma linha, nenhuma falha (ON CONFLICT é atômico)', async () => {
      const resultados = await Promise.allSettled(Array.from({ length: 5 }, () => created.handle(taskCreated)));

      expect(resultados.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await db.prisma.taskRead.count()).toBe(1);
    });

    it('deve gravar prioridade e prazo vindos do evento', async () => {
      await created.handle(taskCreated);

      const row = await db.prisma.taskRead.findUniqueOrThrow({ where: { id: taskId } });
      expect(row).toMatchObject({
        status: 'PENDING',
        priority: 'HIGH',
        dueDate: new Date('2026-12-31T23:59:59.000Z'),
      });
    });
  });

  // ============================================================
  // Eventos de ciclo de vida: UPDATE ... SET (idempotente por natureza)
  // ============================================================
  describe('ciclo de vida (UPDATE idempotente)', () => {
    it('reaplicar a sequência inteira de eventos produz o MESMO estado final', async () => {
      const sequencia = async () => {
        await created.handle(taskCreated);
        await assigned.handle(new TaskAssignedEvent({ taskId, assigneeId: '33333333-3333-4333-8333-333333333333' }));
        await statusChanged.handle(new TaskStatusChangedEvent({ taskId, from: 'PENDING', to: 'IN_PROGRESS' }));
        await completed.handle(new TaskCompletedEvent({ taskId, completedAt: '2026-10-18T12:00:00.000Z' }));
      };

      await sequencia();
      const primeiraVez = await db.prisma.taskRead.findUniqueOrThrow({ where: { id: taskId } });

      await sequencia(); // replay completo
      const segundaVez = await db.prisma.taskRead.findUniqueOrThrow({ where: { id: taskId } });

      const { updatedAt: _a, ...estado1 } = primeiraVez;
      const { updatedAt: _b, ...estado2 } = segundaVez;
      expect(estado2).toEqual(estado1);
      expect(estado2).toMatchObject({ status: 'DONE', completedAt: new Date('2026-10-18T12:00:00.000Z') });
      expect(await db.prisma.taskRead.count()).toBe(1);
    });

    it('evento de atualização para tarefa ausente não quebra (vira WARN) e não cria linha fantasma', async () => {
      await expect(
        assigned.handle(new TaskAssignedEvent({ taskId, assigneeId: '33333333-3333-4333-8333-333333333333' })),
      ).resolves.toBeUndefined();

      expect(await db.prisma.taskRead.count()).toBe(0);
    });
  });

  // ============================================================
  // O banco como última linha de defesa
  // ============================================================
  it('o Postgres deve RECUSAR um status fora do enum TaskStatus (mesmo escrevendo SQL direto)', async () => {
    await created.handle(taskCreated);

    await expect(
      db.prisma.$executeRawUnsafe(`UPDATE "tasks_read" SET "status" = 'FEITO' WHERE "id" = '${taskId}'`),
    ).rejects.toThrow();
  });
});
