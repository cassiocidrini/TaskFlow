/**
 * Do evento aos números do projeto, com Kafka e PostgreSQL REAIS — Módulo 13.6a.
 *
 * Caminho de produção sem HTTP: Event Store + outbox (código real) → relay → `taskflow.task-events.v1` → DOIS
 * consumer groups ao mesmo tempo, `reports` e `notifications`, cada um com o handler real. Protege:
 * - dois grupos, um tópico: cada um lê TODAS as mensagens, independente do outro;
 * - os números do projeto batem com o que aconteceu (status, sem responsável, lead time);
 * - o relay republicando tudo (o at-least-once da 13.3) não dobra nada: a guarda de versão do `reports` e o
 *   `processed_events` do `notifications`, cada um com a sua forma de idempotência;
 * - **reconstrução pelo replay do Event Store (13.6b):** o runbook (parar, limpar, `replay`, subir) devolve os
 *   MESMOS números, mais uma tarefa que nunca passou pela outbox; e o `notifications` lê as mensagens de replay e
 *   não notifica nada, nem a atribuição dessa tarefa (que ele nunca viu).
 */
import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import {
  KafkaConsumerRunner,
  type ConsumedMessage,
  type HandleResult,
} from '../../src/common/messaging/kafka-consumer.runner';
import type { RelayEnv } from '../../src/config/relay-env.schema';
import { EventStoreService } from '../../src/events/event-store.service';
import { NOTIFICATIONS_DLT } from '../../src/modules/notifications/consumer/notifications.consumer';
import { NotificationsHandler } from '../../src/modules/notifications/consumer/notifications.handler';
import { REPORTS_DLT } from '../../src/modules/reports/consumer/reports.consumer';
import { ReportsHandler } from '../../src/modules/reports/consumer/reports.handler';
import { TaskAggregate } from '../../src/modules/tasks/domain/task.aggregate';
import { TASK_EVENT_SCHEMA_VERSIONS } from '../../src/modules/tasks/events/task.events';
import {
  TASK_EVENTS_TOPIC,
  toTaskOutboxMessage,
} from '../../src/modules/tasks/events/task.integration-events';
import { EventSourcedTaskRepository } from '../../src/modules/tasks/infrastructure/event-sourced-task.repository';
import { KafkaMessagePublisher } from '../../src/outbox-relay/kafka-message-publisher';
import { OutboxRelay } from '../../src/outbox-relay/outbox-relay.service';
import { OutboxStore } from '../../src/outbox-relay/outbox.store';
import { TaskEventReplayer } from '../../src/replay/task-event-replayer';
import {
  startTestDatabase,
  type TestDatabase,
} from '../integration/support/test-database';
import { startTestKafka, type TestKafka } from './support/kafka-container';

describe('Evento → Kafka → consumer de relatórios (streaming)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let kafka: TestKafka;
  let eventStore: EventStoreService;
  let publisher: KafkaMessagePublisher;
  let relay: OutboxRelay;
  const runners: KafkaConsumerRunner[] = [];
  let admin: KafkaJS.Admin;
  let reportsRunner: KafkaConsumerRunner;

  const OWNER = randomUUID();
  const ANA = randomUUID();
  const PROJECT = randomUUID();
  const logger = new Logger('reports-streaming-test');

  /** Resultados por grupo: o teste espera por eles em vez de dormir */
  const results: Record<string, HandleResult[]> = {
    reports: [],
    notifications: [],
  };

  const startGroup = async (
    groupId: 'reports' | 'notifications',
    handle: (m: ConsumedMessage) => Promise<HandleResult>,
    deadLetterTopic: string,
  ) => {
    const runner = new KafkaConsumerRunner({
      brokers: kafka.brokers,
      groupId,
      topics: [TASK_EVENTS_TOPIC],
      deadLetterTopic,
      acceptsReplay: groupId === 'reports', // como em produção: projeção aplica, efeito ignora
      partitionsConsumedConcurrently: 3,
      logger,
      handle: async (message) => {
        const result = await handle(message);
        results[groupId].push(result);
        return result;
      },
    });
    runners.push(runner);
    await runner.start();
    return runner;
  };

  /** Uma tarefa pelo caminho do `CreateTaskHandler`, e então os comandos no agregado real */
  const createTask = async (assigneeId?: string): Promise<string> => {
    const taskId = randomUUID();
    const data = {
      taskId,
      projectId: PROJECT,
      title: `Tarefa ${taskId.slice(0, 8)}`,
      priority: 'MEDIUM' as const,
      ...(assigneeId ? { assigneeId } : {}),
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
  const onTask = async (taskId: string, act: (task: TaskAggregate) => void) => {
    const repository = new EventSourcedTaskRepository(eventStore);
    const task = (await repository.load(taskId)) as TaskAggregate;
    act(task);
    await repository.save(task, { actorId: OWNER });
  };

  const drainOutbox = async () => {
    for (let i = 0; i < 50; i++) {
      const outcome = await relay.runCycle();
      if (outcome.kind === 'failed') throw new Error(outcome.error);
      if (outcome.kind === 'published' && outcome.count === 0) return;
    }
  };

  const waitFor = async (predicate: () => boolean, what: string) => {
    const deadline = Date.now() + 30_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  beforeAll(async () => {
    [db, kafka] = await Promise.all([startTestDatabase(), startTestKafka()]);
    prisma = db.prisma;
    eventStore = new EventStoreService(prisma as never);

    admin = new KafkaJS.Kafka({
      kafkaJS: { brokers: kafka.brokers, logLevel: KafkaJS.logLevel.ERROR },
    }).admin();
    await admin.connect();
    await admin.createTopics({
      topics: [TASK_EVENTS_TOPIC, REPORTS_DLT, NOTIFICATIONS_DLT].map(
        (topic) => ({ topic, numPartitions: 3 }),
      ),
    });

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

  afterAll(async () => {
    await admin?.disconnect();
    await Promise.all(runners.map((r) => r.stop()));
    await publisher?.beforeApplicationShutdown();
    await Promise.all([db?.stop(), kafka?.stop()]);
  });

  it('dois grupos no mesmo tópico; números do projeto certos; republicar tudo não dobra nada', async () => {
    reportsRunner = await startGroup(
      'reports',
      (m) => new ReportsHandler(prisma as never).handle(m),
      REPORTS_DLT,
    );
    await startGroup(
      'notifications',
      (m) => new NotificationsHandler(prisma as never).handle(m),
      NOTIFICATIONS_DLT,
    );

    // 4 tarefas: uma concluída (com responsável), uma em andamento, uma atribuída depois e uma sem responsável
    const done = await createTask(ANA);
    const inProgress = await createTask(ANA);
    const assignedLater = await createTask();
    await createTask();
    await onTask(inProgress, (t) => t.changeStatus('IN_PROGRESS'));
    await onTask(assignedLater, (t) => t.assign(ANA));
    await onTask(done, (t) => t.complete(new Date()));
    await drainOutbox();

    const events = await prisma.outboxMessage.count();
    expect(events).toBe(7); // 4 criações + início + atribuição + conclusão
    await waitFor(
      () =>
        results.reports.length === events &&
        results.notifications.length === events,
      'os dois grupos lerem tudo',
    );

    const expected = {
      total: 4,
      pending: 2,
      inProgress: 1,
      done: 1,
      unassignedOpen: 1,
    };
    expect(
      await prisma.projectStats.findUniqueOrThrow({
        where: { projectId: PROJECT },
      }),
    ).toMatchObject(expected);
    const notificationsBefore = await prisma.notification.count();

    // O relay "perde o COMMIT" de tudo e republica: o tópico passa a ter cada evento DUAS vezes
    await prisma.outboxMessage.updateMany({ data: { publishedAt: null } });
    await drainOutbox();
    await waitFor(
      () =>
        results.reports.length === 2 * events &&
        results.notifications.length === 2 * events,
      'as reentregas',
    );

    // Cada grupo reconheceu as cópias do SEU jeito: versão (reports) e processed_events (notifications)
    expect(results.reports.slice(events)).toEqual(
      Array(events).fill('duplicate'),
    );
    expect(
      results.notifications.slice(events).filter((r) => r !== 'ignored'), // TaskStatusChanged: o notifications ignora sempre
    ).toEqual(Array(events - 1).fill('duplicate'));
    expect(
      await prisma.projectStats.findUniqueOrThrow({
        where: { projectId: PROJECT },
      }),
    ).toMatchObject(expected);
    expect(await prisma.notification.count()).toBe(notificationsBefore);
  });

  /** Mensagens que o grupo ainda não commitou (soma das partições): 0 = leu tudo */
  const lagOf = async (groupId: string) => {
    const [committed] = await admin.fetchOffsets({
      groupId,
      topics: [TASK_EVENTS_TOPIC],
    });
    const ends = await admin.fetchTopicOffsets(TASK_EVENTS_TOPIC);
    return ends.reduce((lag, end) => {
      const done = committed.partitions.find(
        (p) => p.partition === end.partition,
      );
      return lag + Number(end.high) - Math.max(0, Number(done?.offset ?? 0));
    }, 0);
  };

  it('reconstrução do reports pelo replay do Event Store: os mesmos números; o notifications ignora o replay', async () => {
    const before = await prisma.projectStats.findUniqueOrThrow({
      where: { projectId: PROJECT },
    });
    const notificationsBefore = await prisma.notification.count();

    // Uma tarefa "anterior à outbox": só no Event Store, nunca publicada, já atribuída à Ana. É o caso de uso do
    // replay, e o único em que o header importa para o notifications: as outras mensagens de replay têm eventIds
    // que ele já processou (o processed_events as descartaria de qualquer jeito)
    const legacyId = randomUUID();
    const legacyData = {
      taskId: legacyId,
      projectId: PROJECT,
      title: 'Anterior à outbox',
      priority: 'LOW' as const,
      assigneeId: ANA,
    };
    await eventStore.append(
      {
        aggregateId: legacyId,
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: { ...legacyData },
        schemaVersion: TASK_EVENT_SCHEMA_VERSIONS.TaskCreated,
      },
      0,
      { actorId: OWNER },
    ); // sem `toOutbox`: não vai para o tópico

    // Runbook do Módulo 13: 1. parar o consumer; 2. limpar a projeção
    await reportsRunner.stop();
    runners.splice(runners.indexOf(reportsRunner), 1);
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "report_tasks", "project_stats"',
    );

    // 3. replay do Event Store (o tópico NÃO é a fonte: o histórico vem da tabela events)
    const replay = await new TaskEventReplayer(prisma as never).replay();
    expect(replay.messages).toBe(await prisma.event.count());
    await drainOutbox();

    // 4. subir de novo: o grupo retoma do offset commitado, então lê só as mensagens de replay
    const seen = results.reports.length;
    reportsRunner = await startGroup(
      'reports',
      (m) => new ReportsHandler(prisma as never).handle(m),
      REPORTS_DLT,
    );
    await waitFor(
      () => results.reports.length === seen + replay.messages,
      'o reports aplicar o replay',
    );

    expect(results.reports.slice(seen)).toEqual(
      Array(replay.messages).fill('processed'),
    );
    const { updatedAt: _a, ...rebuilt } =
      await prisma.projectStats.findUniqueOrThrow({
        where: { projectId: PROJECT },
      });
    const { updatedAt: _b, ...original } = before;
    // Os mesmos números, MAIS a tarefa anterior à outbox, que entrou nos relatórios pela primeira vez. Lead time e
    // `asOf` iguais: o instante original vem no envelope do replay
    expect(rebuilt).toEqual({
      ...original,
      total: original.total + 1,
      pending: original.pending + 1,
      lastEventAt: rebuilt.lastEventAt, // a tarefa nova é o evento mais recente
    });
    expect(rebuilt.lastEventAt!.getTime()).toBeGreaterThanOrEqual(
      original.lastEventAt!.getTime(),
    );

    // O notifications recebeu as mesmas mensagens de replay, commitou e não notificou ninguém
    const deadline = Date.now() + 30_000;
    while ((await lagOf('notifications')) > 0) {
      if (Date.now() > deadline)
        throw new Error('timeout: notifications com lag');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(await prisma.notification.count()).toBe(notificationsBefore);
  });
});
