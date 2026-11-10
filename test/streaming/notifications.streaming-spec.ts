/**
 * Do evento à notificação, com Kafka e PostgreSQL REAIS — Módulo 13.4.
 *
 * Caminho de produção inteiro, sem HTTP: Event Store + outbox (código real) → relay → `taskflow.task-events.v1` →
 * `KafkaConsumerRunner` com o `NotificationsHandler` real. Protege o que o consumer promete:
 * - cada evento vira (no máximo) uma notificação, mesmo quando o tópico tem o mesmo evento DUAS vezes (o relay
 *   republica depois de perder o COMMIT — o at-least-once da 13.3);
 * - mensagem que falha volta (com backoff) e é processada uma vez quando passa, sem que as seguintes da partição
 *   passem na frente;
 * - consumer reiniciado continua do offset commitado: não reprocessa o que já fez;
 * - o trace atravessa a outbox e o Kafka: o span `process` do consumer fica no MESMO trace do request que gravou o
 *   evento, filho do `create` do relay (o header `traceparent` de verdade, passando pelo broker real).
 */
import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import {
  KafkaConsumerRunner,
  type ConsumedMessage,
  type HandleResult,
} from '../../src/common/messaging/kafka-consumer.runner';
import type { RelayEnv } from '../../src/config/relay-env.schema';
import { EventStoreService } from '../../src/events/event-store.service';
import { TaskAggregate } from '../../src/modules/tasks/domain/task.aggregate';
import { NotificationsHandler } from '../../src/modules/notifications/consumer/notifications.handler';
import {
  TASK_EVENTS_TOPIC,
  toTaskOutboxMessage,
} from '../../src/modules/tasks/events/task.integration-events';
import { TASK_EVENT_SCHEMA_VERSIONS } from '../../src/modules/tasks/events/task.events';
import { EventSourcedTaskRepository } from '../../src/modules/tasks/infrastructure/event-sourced-task.repository';
import { KafkaMessagePublisher } from '../../src/outbox-relay/kafka-message-publisher';
import { OutboxRelay } from '../../src/outbox-relay/outbox-relay.service';
import { OutboxStore } from '../../src/outbox-relay/outbox.store';
import {
  startTestDatabase,
  type TestDatabase,
} from '../integration/support/test-database';
import {
  startInMemoryTracing,
  type InMemoryTracing,
} from '../support/in-memory-tracing';
import { startTestKafka, type TestKafka } from './support/kafka-container';

describe('Evento → Kafka → consumer de notificações (streaming)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let kafka: TestKafka;
  let eventStore: EventStoreService;
  let publisher: KafkaMessagePublisher;
  let relay: OutboxRelay;
  let handler: NotificationsHandler;
  let tracing: InMemoryTracing;

  const OWNER = randomUUID();
  const ANA = randomUUID();
  const PROJECT = randomUUID();
  const logger = new Logger('streaming-test');

  /** Resultados do consumer, na ordem em que saíram: o teste espera por eles em vez de dormir */
  const results: { eventType: string; taskId: string; result: HandleResult }[] =
    [];
  let consumer: KafkaConsumerRunner | undefined;

  const startConsumer = async (groupId = 'notifications') => {
    consumer = new KafkaConsumerRunner({
      brokers: kafka.brokers,
      groupId,
      topics: [TASK_EVENTS_TOPIC],
      partitionsConsumedConcurrently: 3,
      logger,
      handle: async (message) => {
        const result = await handler.handle(message);
        results.push({ ...describeMessage(message), result });
        return result;
      },
    });
    await consumer.start();
  };

  /** Cria uma tarefa já atribuída à Ana (pelo caminho do `CreateTaskHandler`) e a conclui pelo repositório */
  const createAndComplete = async (): Promise<string> => {
    const taskId = randomUUID();
    const data = {
      taskId,
      projectId: PROJECT,
      title: `Tarefa ${taskId.slice(0, 8)}`,
      priority: 'MEDIUM' as const,
      assigneeId: ANA,
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
    const repository = new EventSourcedTaskRepository(eventStore);
    const task = (await repository.load(taskId)) as TaskAggregate;
    task.complete(new Date());
    await repository.save(task, { actorId: OWNER });
    return taskId;
  };

  const drainOutbox = async () => {
    for (let i = 0; i < 50; i++) {
      const outcome = await relay.runCycle();
      if (outcome.kind === 'failed') throw new Error(outcome.error);
      if (outcome.kind === 'published' && outcome.count === 0) return;
    }
  };

  const waitFor = async (
    predicate: () => boolean,
    what: string,
    timeoutMs = 30_000,
  ) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    tracing = startInMemoryTracing();
    [db, kafka] = await Promise.all([startTestDatabase(), startTestKafka()]);
    prisma = db.prisma;
    eventStore = new EventStoreService(prisma as never);
    handler = new NotificationsHandler(prisma as never);

    const admin = new KafkaJS.Kafka({
      kafkaJS: { brokers: kafka.brokers, logLevel: KafkaJS.logLevel.ERROR },
    }).admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: TASK_EVENTS_TOPIC, numPartitions: 3 }],
    });
    await admin.disconnect();

    const env: Partial<RelayEnv> = {
      KAFKA_BROKERS: kafka.brokers,
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_BATCH_SIZE: 100,
      OUTBOX_RETENTION_HOURS: 72,
    };
    const config = {
      get: (key: keyof RelayEnv) => env[key],
    } as unknown as ConfigService<RelayEnv, true>;
    publisher = new KafkaMessagePublisher(config);
    relay = new OutboxRelay(
      new OutboxStore(prisma as never),
      publisher,
      config,
    );
  }, 180_000);

  afterEach(async () => {
    await consumer?.stop();
    consumer = undefined;
  });

  afterAll(async () => {
    await publisher?.beforeApplicationShutdown();
    await tracing?.stop();
    await Promise.all([db?.stop(), kafka?.stop()]);
  });

  it('pipeline completo; o mesmo evento publicado 2 vezes não gera notificação extra', async () => {
    await startConsumer();
    const taskId = await createAndComplete();
    await drainOutbox();
    await waitFor(
      () => results.filter((r) => r.taskId === taskId).length === 2,
      '2 eventos',
    );

    expect(
      (
        await prisma.notification.findMany({
          where: { taskId },
          orderBy: { createdAt: 'asc' },
        })
      ).map((n) => [n.userId, n.type]),
    ).toEqual([
      [ANA, 'TASK_ASSIGNED'],
      [ANA, 'TASK_COMPLETED'],
    ]);

    // O relay "perde o COMMIT" depois do ack e republica: o tópico passa a ter cada evento DUAS vezes
    await prisma.outboxMessage.updateMany({
      where: { messageKey: taskId },
      data: { publishedAt: null },
    });
    await drainOutbox();
    await waitFor(
      () => results.filter((r) => r.taskId === taskId).length === 4,
      'as reentregas',
    );

    expect(
      results.filter((r) => r.taskId === taskId).map((r) => r.result),
    ).toEqual(['processed', 'processed', 'duplicate', 'duplicate']);
    expect(await prisma.notification.count({ where: { taskId } })).toBe(2);
  });

  it('consumer reiniciado continua do offset commitado: só os eventos novos', async () => {
    await startConsumer();
    const before = await createAndComplete();
    await drainOutbox();
    await waitFor(
      () => results.filter((r) => r.taskId === before).length === 2,
      'tarefa antiga',
    );
    await consumer?.stop();
    consumer = undefined;

    const seen = results.length;
    const after = await createAndComplete(); // publicada com o consumer parado
    await drainOutbox();
    await startConsumer(); // mesmo grupo: retoma do offset commitado
    await waitFor(
      () => results.filter((r) => r.taskId === after).length === 2,
      'tarefa nova',
    );

    // Depois do restart, só passaram os 2 eventos da tarefa nova: nada reprocessado
    expect(results.slice(seen).map((r) => r.taskId)).toEqual([after, after]);
  });

  it('um trace só, do request ao consumer: process filho do create, create filho do request', async () => {
    await startConsumer();
    // O "request": o mesmo span ativo que a instrumentação HTTP abre na API
    const { origin, taskId } = await trace
      .getTracer('test')
      .startActiveSpan('POST /projects/:projectId/tasks', async (span) => {
        const id = await createAndComplete();
        span.end();
        return { origin: span.spanContext(), taskId: id };
      });
    await drainOutbox();

    const eventIds = (
      await prisma.outboxMessage.findMany({ where: { messageKey: taskId } })
    ).map((row) => row.eventId);
    const spansOf = (name: string) =>
      tracing
        .named(name)
        .filter((s) =>
          eventIds.includes(String(s.attributes['messaging.message.id'])),
        );
    await waitFor(
      () => spansOf(`process ${TASK_EVENTS_TOPIC}`).length === 2,
      'os spans do consumer',
    );

    const creates = spansOf(`create ${TASK_EVENTS_TOPIC}`);
    const processes = spansOf(`process ${TASK_EVENTS_TOPIC}`);
    expect(creates).toHaveLength(2);
    for (const create of creates) {
      expect(create.spanContext().traceId).toBe(origin.traceId);
      expect(create.parentSpanContext?.spanId).toBe(origin.spanId);
    }
    for (const consumed of processes) {
      expect(consumed.spanContext().traceId).toBe(origin.traceId); // MESMO trace do request
      expect(creates.map((c) => c.spanContext().spanId)).toContain(
        consumed.parentSpanContext?.spanId, // continua do create, pelo header que passou no broker
      );
    }
  });

  it('mensagem que falha volta com backoff e é processada uma vez; a seguinte não passa na frente', async () => {
    const order: string[] = [];
    let attempts = 0;
    consumer = new KafkaConsumerRunner({
      brokers: kafka.brokers,
      groupId: 'flaky-consumer', // grupo próprio: lê o tópico do início, sem afetar o `notifications`
      topics: [TASK_EVENTS_TOPIC],
      partitionsConsumedConcurrently: 3,
      logger,
      handle: async (message) => {
        const { eventType, taskId } = describeMessage(message);
        if (
          taskId === flakyTask &&
          eventType === 'TaskCreated' &&
          ++attempts <= 2
        ) {
          throw new Error(`falha simulada nº ${attempts}`);
        }
        if (taskId === flakyTask) order.push(eventType);
        return 'processed';
      },
    });
    const flakyTask = await createAndComplete();
    await drainOutbox();
    await consumer.start();

    await waitFor(() => order.length === 2, 'a tarefa instável', 60_000);
    expect(attempts).toBe(3); // 2 falhas + o sucesso
    expect(order).toEqual(['TaskCreated', 'TaskCompleted']); // o Completed esperou o Created passar
  });
});

function describeMessage(message: ConsumedMessage): {
  eventType: string;
  taskId: string;
} {
  const value = JSON.parse(message.value ?? '{}') as {
    eventType: string;
    aggregateId: string;
  };
  return { eventType: value.eventType, taskId: value.aggregateId };
}
