/**
 * Consumer de relatórios contra PostgreSQL REAL (Testcontainers) — Módulo 13.6a.
 *
 * As propriedades protegidas só existem no banco:
 * - idempotência pela VERSÃO: a mesma mensagem 2 vezes, ou uma versão antiga depois da nova, não muda nada;
 * - 5 entregas SIMULTÂNEAS do mesmo evento (rebalance) aplicam uma vez só (`FOR UPDATE` + versão);
 * - 20 tarefas do mesmo projeto concluídas em PARALELO não perdem contagem (incremento atômico na mesma linha);
 * - evento de tarefa sem `TaskCreated` conhecido não escreve nada;
 * - evento que contradiz o projeto guardado da tarefa é mensagem corrupta (`NonRetryableError`, DLT na hora);
 * - `last_event_at` só avança (eventos de partições diferentes chegam fora de ordem) e volta como o mesmo instante;
 * - o CHECK do banco recusa contador negativo.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ConsumedMessage } from '../../src/common/messaging/kafka-consumer.runner';
import { ReportsHandler } from '../../src/modules/reports/consumer/reports.handler';
import { InvalidReportMessageError } from '../../src/modules/reports/consumer/task-event.message';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('ReportsHandler (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let handler: ReportsHandler;

  const PROJECT = randomUUID();
  const ANA = randomUUID();

  /** Mensagem como o relay a publica (o handler só lê o value) */
  const message = (
    taskId: string,
    version: number,
    eventType: string,
    data: Record<string, unknown>,
    occurredAt = new Date().toISOString(),
  ): ConsumedMessage => ({
    topic: 'taskflow.task-events.v1',
    partition: 0,
    offset: '0',
    key: taskId,
    headers: {},
    value: JSON.stringify({
      eventId: randomUUID(),
      eventType,
      eventVersion: 1,
      occurredAt,
      aggregateId: taskId,
      aggregateVersion: version,
      projectId: PROJECT,
      actorId: randomUUID(),
      data,
    }),
  });

  const created = (taskId: string, occurredAt?: string) =>
    message(taskId, 1, 'TaskCreated', {}, occurredAt);
  const assigned = (taskId: string, version = 2) =>
    message(taskId, version, 'TaskAssigned', { assigneeId: ANA });
  const completed = (taskId: string, version: number, completedAt: string) =>
    message(taskId, version, 'TaskCompleted', { completedAt });

  const stats = () =>
    prisma.projectStats.findUniqueOrThrow({ where: { projectId: PROJECT } });

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    handler = new ReportsHandler(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "report_tasks", "project_stats"',
    );
  });

  it('ciclo completo: contadores e lead time do projeto', async () => {
    const taskId = randomUUID();
    const results = [];
    for (const m of [
      created(taskId, '2026-11-10T10:00:00.000Z'),
      assigned(taskId),
      message(taskId, 3, 'TaskStatusChanged', {
        from: 'PENDING',
        to: 'IN_PROGRESS',
      }),
      completed(taskId, 4, '2026-11-10T12:00:00.000Z'),
    ]) {
      results.push(await handler.handle(m));
    }

    expect(results).toEqual([
      'processed',
      'processed',
      'processed',
      'processed',
    ]);
    expect(await stats()).toMatchObject({
      total: 1,
      pending: 0,
      inProgress: 0,
      done: 1,
      unassignedOpen: 0,
      leadTimeSecondsSum: 7_200,
    });
    expect(
      await prisma.reportTask.findUniqueOrThrow({ where: { taskId } }),
    ).toMatchObject({ status: 'DONE', assigneeId: ANA, version: 4 });
  });

  it('a mesma mensagem 2 vezes: a 2ª é duplicate e os contadores não mudam', async () => {
    const taskId = randomUUID();
    const create = created(taskId);
    const assign = assigned(taskId);

    await handler.handle(create);
    await handler.handle(assign);
    await expect(handler.handle(create)).resolves.toBe('duplicate');
    await expect(handler.handle(assign)).resolves.toBe('duplicate');

    expect(await stats()).toMatchObject({
      total: 1,
      pending: 1,
      unassignedOpen: 0,
    });
  });

  it('versão ANTIGA depois da nova (reentrega atrasada): duplicate, sem desfazer o que já foi aplicado', async () => {
    const taskId = randomUUID();
    await handler.handle(created(taskId));
    await handler.handle(assigned(taskId, 2));
    await handler.handle(
      message(taskId, 3, 'TaskStatusChanged', {
        from: 'PENDING',
        to: 'IN_PROGRESS',
      }),
    );

    // Um evento de versão 2 com outro conteúdo (outra entrega, outro eventId): a versão manda, não o eventId
    await expect(
      handler.handle(
        message(taskId, 2, 'TaskStatusChanged', {
          from: 'IN_PROGRESS',
          to: 'PENDING',
        }),
      ),
    ).resolves.toBe('duplicate');

    expect(await stats()).toMatchObject({ pending: 0, inProgress: 1 });
  });

  it('5 entregas SIMULTÂNEAS do mesmo evento: aplicado uma vez só', async () => {
    const taskId = randomUUID();
    const create = created(taskId);
    const createResults = await Promise.all(
      Array.from({ length: 5 }, () => handler.handle(create)),
    );
    const assign = assigned(taskId);
    const assignResults = await Promise.all(
      Array.from({ length: 5 }, () => handler.handle(assign)),
    );

    for (const results of [createResults, assignResults]) {
      expect(results.filter((r) => r === 'processed')).toHaveLength(1);
      expect(results.filter((r) => r === 'duplicate')).toHaveLength(4);
    }
    expect(await stats()).toMatchObject({
      total: 1,
      pending: 1,
      unassignedOpen: 0,
    });
  });

  it('20 tarefas do mesmo projeto concluídas em PARALELO: nenhuma contagem perdida', async () => {
    const tasks = Array.from({ length: 20 }, () => randomUUID());
    await Promise.all(tasks.map((taskId) => handler.handle(created(taskId))));

    // Cada tarefa numa "partição" diferente: todas atualizam a MESMA linha de project_stats ao mesmo tempo
    await Promise.all(
      tasks.map((taskId) =>
        handler.handle(completed(taskId, 2, new Date().toISOString())),
      ),
    );

    expect(await stats()).toMatchObject({
      total: 20,
      pending: 0,
      done: 20,
      unassignedOpen: 0,
    });
  });

  it('evento de tarefa sem TaskCreated conhecido (anterior à outbox): unknown_task, nada escrito', async () => {
    await expect(handler.handle(assigned(randomUUID()))).resolves.toBe(
      'unknown_task',
    );

    expect(await prisma.reportTask.count()).toBe(0);
    expect(await prisma.projectStats.count()).toBe(0);
  });

  it('evento que muda a tarefa de projeto (mensagem corrupta): InvalidReportMessageError, nada alterado', async () => {
    const taskId = randomUUID();
    await handler.handle(created(taskId));
    const moved = JSON.parse(assigned(taskId).value ?? '{}') as Record<
      string,
      unknown
    >;
    const otherProject: ConsumedMessage = {
      ...assigned(taskId),
      value: JSON.stringify({ ...moved, projectId: randomUUID() }),
    };

    // NonRetryableError: o runner manda ao DLT na 1ª falha, sem travar a partição em 5 tentativas
    await expect(handler.handle(otherProject)).rejects.toBeInstanceOf(
      InvalidReportMessageError,
    );
    expect(await stats()).toMatchObject({ total: 1, unassignedOpen: 1 });
    expect(
      (await prisma.reportTask.findUniqueOrThrow({ where: { taskId } }))
        .version,
    ).toBe(1);
  });

  it('last_event_at só avança, e volta como o MESMO instante (sem deslocamento de fuso)', async () => {
    const later = '2026-11-10T18:30:02.377Z';
    await handler.handle(created(randomUUID(), later));
    // Outra tarefa, evento mais antigo, processado depois (outra partição, mais atrasada)
    await handler.handle(created(randomUUID(), '2026-11-10T09:00:00.000Z'));

    expect((await stats()).lastEventAt?.toISOString()).toBe(later);
  });

  it('o banco recusa contador negativo (CHECK): bug de delta vira erro, não número errado', async () => {
    await handler.handle(created(randomUUID()));

    await expect(
      prisma.$executeRaw`UPDATE project_stats SET pending = pending - 2`,
    ).rejects.toThrow(/project_stats_counters_non_negative/);
  });
});
