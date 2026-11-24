/**
 * Consumer de notificações contra PostgreSQL REAL (Testcontainers) — Módulo 13.4.
 *
 * A propriedade protegida é a IDEMPOTÊNCIA do consumer, que só existe no banco:
 * - a mesma mensagem entregue 2 vezes (o Kafka é at-least-once) gera UMA notificação; a 2ª entrega é `duplicate`;
 * - 5 entregas SIMULTÂNEAS do mesmo evento (rebalance no meio do processamento) também geram uma só;
 * - marca e efeito são atômicos: se o efeito falha, `processed_events` NÃO fica marcado, e a reentrega processa
 *   (o contrário perderia a notificação para sempre);
 * - a projeção local leva o responsável do `TaskAssigned` até o `TaskCompleted`;
 * - tipo ignorado não escreve nada;
 * - o push (Módulo 13.7) é enfileirado DENTRO da transação: fila fora desfaz marca e notificação (a reentrega
 *   processa tudo de novo), e duplicata não enfileira outra vez. Fila falsa que grava ou falha: o SQS de verdade é
 *   do roteiro manual com LocalStack (o token dele não vai para o CI).
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ConsumedMessage } from '../../src/common/messaging/kafka-consumer.runner';
import { NotificationsHandler } from '../../src/modules/notifications/consumer/notifications.handler';
import {
  PushQueue,
  type PushRequest,
} from '../../src/modules/notifications/consumer/push-queue';
import { InvalidMessageError } from '../../src/modules/notifications/consumer/task-event.message';
import { InfrastructureError } from '../../src/common/messaging/consumer-errors';
import { startTestDatabase, TestDatabase } from './support/test-database';

/** Fila falsa: guarda o que foi enfileirado e, com `failing`, recusa como um SQS fora do ar. */
class RecordingPushQueue extends PushQueue {
  readonly sent: PushRequest[] = [];
  failing = false;

  enqueue(request: PushRequest): Promise<void> {
    if (this.failing) {
      return Promise.reject(new InfrastructureError('SQS fora (simulado)'));
    }
    this.sent.push(request);
    return Promise.resolve();
  }
}

describe('NotificationsHandler (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let handler: NotificationsHandler;
  const pushQueue = new RecordingPushQueue();

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
    handler = new NotificationsHandler(prisma as never, pushQueue);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "notifications", "notification_tasks", "processed_events"',
    );
    pushQueue.sent.length = 0;
    pushQueue.failing = false;
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

  it('mensagem malformada de um tipo tratado: falha alto com InvalidMessageError (o runner a manda ao DLT)', async () => {
    const handling = handler.handle(
      message('TaskAssigned', { assigneeId: 'nao-e-uuid' }),
    );
    await expect(handling).rejects.toThrow('TaskAssigned inválido');
    // A classe é o que decide o destino: NonRetryableError vai ao DLT sem novas tentativas
    await expect(handling).rejects.toBeInstanceOf(InvalidMessageError);
  });

  describe('push (13.7)', () => {
    const eventIdOf = (m: ConsumedMessage) =>
      (JSON.parse(m.value ?? '{}') as { eventId: string }).eventId;

    it('cada notificação enfileira um push, com o eventId como chave de idempotência', async () => {
      const events = lifecycle();
      for (const m of events) await handler.handle(m);

      // TaskCreated sem responsável não notifica; atribuição e conclusão, sim
      expect(pushQueue.sent.map((p) => [p.pushId, p.userId, p.type])).toEqual([
        [eventIdOf(events[1]), ANA, 'TASK_ASSIGNED'],
        [eventIdOf(events[2]), ANA, 'TASK_COMPLETED'],
      ]);
    });

    it('fila fora: nada fica gravado nem marcado, e a reentrega faz tudo', async () => {
      const [created, assigned] = lifecycle();
      await handler.handle(created);

      pushQueue.failing = true;
      const handling = handler.handle(assigned);
      // A classe decide o destino no runner: infraestrutura = retry para sempre, nunca DLT
      await expect(handling).rejects.toBeInstanceOf(InfrastructureError);
      expect(await prisma.notification.count()).toBe(0);
      expect(
        await prisma.processedEvent.count({
          where: { eventId: eventIdOf(assigned) },
        }),
      ).toBe(0);

      pushQueue.failing = false;
      await expect(handler.handle(assigned)).resolves.toBe('processed');
      expect(await prisma.notification.count()).toBe(1);
      expect(pushQueue.sent).toHaveLength(1);
    });

    it('duplicata não enfileira de novo', async () => {
      const [created, assigned] = lifecycle();
      await handler.handle(created);
      await handler.handle(assigned);
      await expect(handler.handle(assigned)).resolves.toBe('duplicate');

      expect(pushQueue.sent).toHaveLength(1);
    });
  });
});
