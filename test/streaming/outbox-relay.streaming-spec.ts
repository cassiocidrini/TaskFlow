/**
 * Do Event Store ao tópico, com Kafka e PostgreSQL REAIS (Testcontainers) — Módulo 13.3.
 *
 * Percorre o caminho inteiro de produção, sem HTTP: eventos gravados pelo código real (Event Store + mapper de
 * integração, como o `CreateTaskHandler` e o repositório fazem) → `OutboxRelay` com o `KafkaMessagePublisher` real →
 * um consumer lendo `taskflow.task-events.v1`. Protege o contrato que os consumers das próximas etapas vão usar:
 * - cada evento chega UMA vez, com chave = taskId, `value` = o evento de integração e os headers do envelope;
 * - todos os eventos de uma tarefa caem na MESMA partição e em ordem de `aggregateVersion`;
 * - at-least-once na prática: se o relay "perder" o COMMIT depois do ack, o lote sai de novo com o MESMO `event-id`
 *   (é por isso que o consumer da 13.4 deduplica por ele).
 *
 * Suíte própria (`npm run test:streaming`, 4º job do CI): sobe um broker, coisa que as outras não precisam.
 */
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { runWithCorrelationId } from '../../src/common/correlation/correlation-context';
import type { RelayEnv } from '../../src/config/relay-env.schema';
import { EventStoreService } from '../../src/events/event-store.service';
import { TaskAggregate } from '../../src/modules/tasks/domain/task.aggregate';
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
import { startTestKafka, type TestKafka } from './support/kafka-container';

interface Received {
  partition: number;
  key: string;
  headers: Record<string, string>;
  value: {
    eventId: string;
    eventType: string;
    aggregateVersion: number;
    correlationId?: string;
  };
}

describe('Outbox → relay → Kafka (streaming)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let kafka: TestKafka;
  let publisher: KafkaMessagePublisher;
  let relay: OutboxRelay;
  let eventStore: EventStoreService;

  const received: Received[] = [];
  let consumer: KafkaJS.Consumer;

  /** Cria uma tarefa como o `CreateTaskHandler` e a leva até concluída pelo repositório real (3 eventos). */
  const createAssignAndComplete = async (taskId: string) => {
    const data = {
      taskId,
      projectId: 'proj-1',
      title: `Tarefa ${taskId}`,
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
      { actorId: 'user-1' },
      {
        toOutbox: (recorded) =>
          toTaskOutboxMessage(
            { type: 'TaskCreated', data },
            recorded,
            data.projectId,
          ),
      },
    );
    const repository = new EventSourcedTaskRepository(eventStore);
    const task = (await repository.load(taskId)) as TaskAggregate;
    task.assign('user-2');
    task.complete(new Date());
    await repository.save(task, { actorId: 'user-1' });
  };

  /** Rodadas do relay até a outbox esvaziar */
  const drainOutbox = async () => {
    for (let i = 0; i < 50; i++) {
      const outcome = await relay.runCycle();
      if (outcome.kind === 'failed') throw new Error(outcome.error);
      if (outcome.kind === 'published' && outcome.count === 0) return;
    }
  };

  /** Espera o consumer acumular `count` mensagens */
  const waitForMessages = async (count: number, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (received.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `esperava ${count} mensagens, chegaram ${received.length}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    [db, kafka] = await Promise.all([startTestDatabase(), startTestKafka()]);
    prisma = db.prisma;
    eventStore = new EventStoreService(prisma as never);

    const client = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: kafka.brokers,
        clientId: 'streaming-test',
        logLevel: KafkaJS.logLevel.ERROR,
      },
    });
    // O contrato do tópico, como o `kafka-init` do compose cria (a autocriação está desligada)
    const admin = client.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: TASK_EVENTS_TOPIC, numPartitions: 3 }],
    });
    await admin.disconnect();

    const env: Partial<RelayEnv> = {
      KAFKA_BROKERS: kafka.brokers,
      OUTBOX_POLL_INTERVAL_MS: 50,
      OUTBOX_BATCH_SIZE: 5, // menor que o total: força vários lotes
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

    consumer = client.consumer({
      kafkaJS: { groupId: 'streaming-test', fromBeginning: true },
    });
    await consumer.connect();
    await consumer.subscribe({ topics: [TASK_EVENTS_TOPIC] });
    void consumer.run({
      eachMessage: async ({ partition, message }) => {
        const headers = Object.fromEntries(
          Object.entries(message.headers ?? {}).map(([name, value]) => [
            name,
            String(value),
          ]),
        );
        received.push({
          partition,
          key: message.key?.toString() ?? '',
          headers,
          value: JSON.parse(
            message.value?.toString() ?? '{}',
          ) as Received['value'],
        });
      },
    });
  }, 180_000);

  afterAll(async () => {
    await consumer?.disconnect();
    await publisher?.beforeApplicationShutdown();
    await Promise.all([db?.stop(), kafka?.stop()]);
  });

  it('cada evento chega uma vez, com chave, headers e ordem por tarefa na mesma partição', async () => {
    const tasks = ['task-a', 'task-b', 'task-c', 'task-d'];
    await runWithCorrelationId('streaming-001', () =>
      createAssignAndComplete(tasks[0]),
    );
    for (const taskId of tasks.slice(1)) {
      await createAssignAndComplete(taskId);
    }

    await drainOutbox();
    await waitForMessages(12);

    // Uma vez cada: os mesmos eventId da outbox, todos marcados como publicados
    const outbox = await prisma.outboxMessage.findMany();
    expect(outbox.every((row) => row.publishedAt !== null)).toBe(true);
    expect(received.map((m) => m.headers['event-id']).sort()).toEqual(
      outbox.map((row) => row.eventId).sort(),
    );

    for (const taskId of tasks) {
      const ofTask = received.filter((m) => m.key === taskId);
      // Mesma chave → mesma partição → ordem garantida pelo Kafka
      expect(new Set(ofTask.map((m) => m.partition)).size).toBe(1);
      expect(
        ofTask.map((m) => [m.value.aggregateVersion, m.value.eventType]),
      ).toEqual([
        [1, 'TaskCreated'],
        [2, 'TaskAssigned'],
        [3, 'TaskCompleted'],
      ]);
      // Headers repetem o envelope: o consumer roteia sem fazer parse do corpo
      for (const message of ofTask) {
        expect(message.headers).toMatchObject({
          'event-id': message.value.eventId,
          'event-type': message.value.eventType,
          'content-type': 'application/json',
        });
      }
    }
    // O correlationId da requisição de origem atravessa até o header da mensagem
    const created = received.find(
      (m) => m.key === 'task-a' && m.value.eventType === 'TaskCreated',
    );
    expect(created?.headers['correlation-id']).toBe('streaming-001');
  });

  it('at-least-once: COMMIT perdido depois do ack republica o lote com o MESMO event-id', async () => {
    const before = received.length;
    await createAssignAndComplete('task-z');
    await drainOutbox();
    await waitForMessages(before + 3);

    // Simula o relay que publicou e caiu antes do COMMIT: as linhas voltam a ficar pendentes
    await prisma.outboxMessage.updateMany({
      where: { messageKey: 'task-z' },
      data: { publishedAt: null },
    });
    await drainOutbox();
    await waitForMessages(before + 6);

    const ofTask = received.filter((m) => m.key === 'task-z');
    const ids = ofTask.map((m) => m.headers['event-id']);
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(3); // duplicatas reconhecíveis pelo event-id → o consumer deduplica (13.4)
  });
});
