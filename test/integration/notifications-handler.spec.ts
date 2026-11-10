/**
 * Consumer de notificações contra PostgreSQL REAL (Testcontainers) — Módulo 13.4.
 *
 * A propriedade protegida é a IDEMPOTÊNCIA do consumer, que só existe no banco:
 * - a mesma mensagem entregue 2 vezes (o Kafka é at-least-once) gera UMA notificação; a 2ª entrega é `duplicate`;
 * - 5 entregas SIMULTÂNEAS do mesmo evento (rebalance no meio do processamento) também geram uma só;
 * - marca e efeito são atômicos: se o efeito falha, `processed_events` NÃO fica marcado, e a reentrega processa
 *   (o contrário perderia a notificação para sempre);
 * - a projeção local leva o responsável do `TaskAssigned` até o `TaskCompleted`;
 * - tipo ignorado não escreve nada.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ConsumedMessage } from '../../src/common/messaging/kafka-consumer.runner';
import { NotificationsHandler } from '../../src/modules/notifications/consumer/notifications.handler';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('NotificationsHandler (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let handler: NotificationsHandler;

  const OWNER = randomUUID();
  const ANA = randomUUID();
  const PROJECT = randomUUID();

  /** Mensagem como o relay a publica (só o que o handler lê: o value) */
  const message = (
    eventType: string,
    data: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): ConsumedMessage => ({
    topic: 'taskflow.task-events.v1',
    partition: 0,
    offset: '0',
    key: null,
    headers: {},
    value: JSON.stringify({
      eventId: randomUUID(),
      eventType,
      eventVersion: 1,
      occurredAt: new Date().toISOString(),
      aggregateId: overrides.taskId ?? randomUUID(),
      aggregateVersion: 1,
      projectId: PROJECT,
      actorId: OWNER,
      data,
      ...overrides,
    }),
  });

  /** Os 3 eventos do ciclo de uma tarefa, na ordem em que o Kafka os entrega */
  const lifecycle = () => {
    const taskId = randomUUID();
    return [
      message(
        'TaskCreated',
        { title: 'Conciliar pagamentos' },
        { taskId, aggregateId: taskId },
      ),
      message(
        'TaskAssigned',
        { assigneeId: ANA },
        { taskId, aggregateId: taskId },
      ),
      message(
        'TaskCompleted',
        { completedAt: new Date().toISOString() },
        { taskId, aggregateId: taskId },
      ),
    ];
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    handler = new NotificationsHandler(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "notifications", "notification_tasks", "processed_events"',
    );
  });

  it('ciclo completo: notifica a atribuição e a conclusão ao responsável', async () => {
    for (const m of lifecycle()) {
      await expect(handler.handle(m)).resolves.toBe('processed');
    }

    const notifications = await prisma.notification.findMany({
      orderBy: { createdAt: 'asc' },
    });
    expect(notifications.map((n) => [n.userId, n.type])).toEqual([
      [ANA, 'TASK_ASSIGNED'],
      [ANA, 'TASK_COMPLETED'],
    ]);
    expect(await prisma.processedEvent.count()).toBe(3);
  });

  it('a mesma mensagem entregue 2 vezes: UMA notificação, a 2ª entrega é duplicate', async () => {
    const [created, assigned] = lifecycle();
    await handler.handle(created);

    await expect(handler.handle(assigned)).resolves.toBe('processed');
    await expect(handler.handle(assigned)).resolves.toBe('duplicate');

    expect(await prisma.notification.count()).toBe(1);
  });

  it('5 entregas SIMULTÂNEAS do mesmo evento: uma notificação só', async () => {
    const [created, assigned] = lifecycle();
    await handler.handle(created);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => handler.handle(assigned)),
    );

    expect(results.filter((r) => r === 'processed')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(4);
    expect(await prisma.notification.count()).toBe(1);
  });

  it('efeito falhou: o evento NÃO fica marcado, e a reentrega processa', async () => {
    const [created, assigned] = lifecycle();
    await handler.handle(created);

    // Derruba o efeito de verdade, no banco: a tabela de destino some no meio do caminho
    await prisma.$executeRawUnsafe(
      'ALTER TABLE "notifications" RENAME TO "notifications_off"',
    );
    try {
      await expect(handler.handle(assigned)).rejects.toThrow();
    } finally {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE "notifications_off" RENAME TO "notifications"',
      );
    }
    const eventId = (JSON.parse(assigned.value ?? '{}') as { eventId: string })
      .eventId;
    expect(await prisma.processedEvent.count({ where: { eventId } })).toBe(0); // marca desfeita junto

    await expect(handler.handle(assigned)).resolves.toBe('processed'); // a reentrega do Kafka
    expect(await prisma.notification.count()).toBe(1);
  });

  it('tipo que não gera notificação: ignored, sem escrever nada', async () => {
    await expect(
      handler.handle(
        message('TaskStatusChanged', { from: 'PENDING', to: 'IN_PROGRESS' }),
      ),
    ).resolves.toBe('ignored');

    expect(await prisma.processedEvent.count()).toBe(0);
  });

  it('mensagem malformada de um tipo tratado: falha alto (vai para o DLT na 13.5)', async () => {
    await expect(
      handler.handle(message('TaskAssigned', { assigneeId: 'nao-e-uuid' })),
    ).rejects.toThrow('TaskAssigned inválido');
  });
});
