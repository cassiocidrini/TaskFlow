/**
 * Redrive do DLT com Kafka e PostgreSQL REAIS — Módulo 13.6c.
 *
 * O ciclo que o redrive existe para fechar: um BUG no handler faz uma mensagem esgotar as tentativas e ir ao DLT
 * (`exhausted`); o bug é corrigido; o redrive a devolve ao tópico de origem e a notificação acontece. Protege também:
 * - `--dry-run` não publica nem grava auditoria;
 * - só o grupo que falhou processa a mensagem reenviada: o `reports`, no mesmo tópico, a ignora (`redrive-group`);
 * - rodar de novo não reenvia o que já foi (tabela `dlt_redrives`, com quem pediu);
 * - `permanent` (contrato violado) só sai com `includePermanent`, e falha igual: volta ao DLT.
 */
import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import {
  KafkaConsumerRunner,
  type ConsumedMessage,
} from '../../src/common/messaging/kafka-consumer.runner';
import { NOTIFICATIONS_DLT } from '../../src/modules/notifications/consumer/notifications.consumer';
import { NotificationsHandler } from '../../src/modules/notifications/consumer/notifications.handler';
import { REPORTS_DLT } from '../../src/modules/reports/consumer/reports.consumer';
import { ReportsHandler } from '../../src/modules/reports/consumer/reports.handler';
import { TASK_EVENTS_TOPIC } from '../../src/modules/tasks/events/task.integration-events';
import { DltRedriver } from '../../src/redrive/dlt-redriver';
import {
  startTestDatabase,
  type TestDatabase,
} from '../integration/support/test-database';
import { startTestKafka, type TestKafka } from './support/kafka-container';

describe('Redrive do DLT (streaming)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let kafka: TestKafka;
  let admin: KafkaJS.Admin;
  let producer: KafkaJS.Producer;
  let redriver: DltRedriver;
  const runners: KafkaConsumerRunner[] = [];

  const OWNER = randomUUID();
  const ANA = randomUUID();
  const PROJECT = randomUUID();
  const logger = new Logger('redrive-test');

  /**
   * O "bug" do handler de notificações: enquanto ligado, o TaskAssigned DESTA tarefa falha com erro desconhecido. Só
   * desta: a envenenada precisa chegar ao handler real para ser classificada como permanent
   */
  let bugActive = true;
  const buggyTask = randomUUID();
  const reportsHandled: string[] = [];

  const event = (
    taskId: string,
    version: number,
    eventType: string,
    data: object,
  ) => {
    const eventId = randomUUID();
    return {
      key: taskId,
      value: JSON.stringify({
        eventId,
        eventType,
        eventVersion: 1,
        occurredAt: new Date().toISOString(),
        aggregateId: taskId,
        aggregateVersion: version,
        projectId: PROJECT,
        actorId: OWNER,
        data,
      }),
      headers: { 'event-id': eventId, 'event-type': eventType },
    };
  };

  const messagesIn = async (topic: string) =>
    (await admin.fetchTopicOffsets(topic)).reduce(
      (total, p) => total + Number(p.high),
      0,
    );
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
  const waitFor = async (
    predicate: () => Promise<boolean> | boolean,
    what: string,
  ) => {
    const deadline = Date.now() + 45_000;
    while (!(await predicate())) {
      if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  beforeAll(async () => {
    [db, kafka] = await Promise.all([startTestDatabase(), startTestKafka()]);
    prisma = db.prisma;
    const client = new KafkaJS.Kafka({
      kafkaJS: { brokers: kafka.brokers, logLevel: KafkaJS.logLevel.ERROR },
    });
    admin = client.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [TASK_EVENTS_TOPIC, NOTIFICATIONS_DLT, REPORTS_DLT].map(
        (topic) => ({
          topic,
          numPartitions: 3,
        }),
      ),
    });
    producer = client.producer();
    await producer.connect();
    redriver = new DltRedriver(prisma, kafka.brokers, logger);

    const notifications = new NotificationsHandler(prisma as never);
    const reports = new ReportsHandler(prisma as never);
    for (const runner of [
      new KafkaConsumerRunner({
        brokers: kafka.brokers,
        groupId: 'notifications',
        topics: [TASK_EVENTS_TOPIC],
        deadLetterTopic: NOTIFICATIONS_DLT,
        acceptsReplay: false,
        maxAttempts: 2,
        partitionsConsumedConcurrently: 3,
        logger,
        handle: async (message: ConsumedMessage) => {
          if (
            bugActive &&
            message.key === buggyTask &&
            message.headers['event-type'] === 'TaskAssigned'
          ) {
            throw new TypeError('bug no handler de notificações');
          }
          return notifications.handle(message);
        },
      }),
      new KafkaConsumerRunner({
        brokers: kafka.brokers,
        groupId: 'reports',
        topics: [TASK_EVENTS_TOPIC],
        deadLetterTopic: REPORTS_DLT,
        acceptsReplay: true,
        partitionsConsumedConcurrently: 3,
        logger,
        handle: async (message: ConsumedMessage) => {
          reportsHandled.push(message.headers['event-id']);
          return reports.handle(message);
        },
      }),
    ]) {
      runners.push(runner);
      await runner.start();
    }
  }, 180_000);

  afterAll(async () => {
    await Promise.all(runners.map((r) => r.stop()));
    await producer?.disconnect();
    await admin?.disconnect();
    await Promise.all([db?.stop(), kafka?.stop()]);
  });

  it('bug → DLT → correção → redrive: a notificação acontece, só no grupo que falhou, uma vez só', async () => {
    const taskId = buggyTask;
    const assigned = event(taskId, 2, 'TaskAssigned', { assigneeId: ANA });
    const assignedEventId = assigned.headers['event-id'];
    // Uma envenenada de OUTRA tarefa: permanente para os dois grupos
    const poisonTask = randomUUID();
    await producer.send({
      topic: TASK_EVENTS_TOPIC,
      messages: [
        event(taskId, 1, 'TaskCreated', { title: 'Conciliar pagamentos' }),
        assigned,
        event(poisonTask, 1, 'TaskCreated', { title: 'Outra' }),
        event(poisonTask, 2, 'TaskAssigned', { assigneeId: 'nao-e-uuid' }),
      ],
    });

    // O bug: o TaskAssigned esgota as 2 tentativas e vai ao DLT; a envenenada vai na 1ª
    await waitFor(
      async () => (await messagesIn(NOTIFICATIONS_DLT)) === 2,
      'o DLT do notifications',
    );
    await waitFor(
      async () => (await lagOf('reports')) === 0,
      'o reports ler tudo',
    );
    expect(await prisma.notification.count({ where: { taskId } })).toBe(0);
    const reportsBefore = reportsHandled.length;

    // A correção é implantada
    bugActive = false;

    // --dry-run: diz o que faria, sem publicar nem gravar
    await expect(
      redriver.redrive({
        group: 'notifications',
        dryRun: true,
        requestedBy: 'ana',
      }),
    ).resolves.toEqual({
      read: 2,
      redriven: 1,
      alreadyRedriven: 0,
      skipped: 1,
    });
    expect(await prisma.dltRedrive.count()).toBe(0);

    // O redrive de verdade: só a exhausted; a permanent fica
    await expect(
      redriver.redrive({
        group: 'notifications',
        requestedBy: 'ana (INC-123)',
      }),
    ).resolves.toEqual({
      read: 2,
      redriven: 1,
      alreadyRedriven: 0,
      skipped: 1,
    });
    await waitFor(
      async () =>
        (await prisma.notification.count({ where: { taskId } })) === 1,
      'a notificação depois do redrive',
    );
    expect(
      await prisma.notification.findFirstOrThrow({ where: { taskId } }),
    ).toMatchObject({
      userId: ANA,
      type: 'TASK_ASSIGNED',
      eventId: assignedEventId,
    });
    expect(await prisma.dltRedrive.findMany()).toEqual([
      expect.objectContaining({
        consumerGroup: 'notifications',
        eventId: assignedEventId,
        reason: 'exhausted',
        requestedBy: 'ana (INC-123)',
      }),
    ]);

    // O reports leu a mensagem reenviada (lag 0) e NÃO a processou: era de outro grupo
    await waitFor(
      async () => (await lagOf('reports')) === 0,
      'o reports ler o redrive',
    );
    expect(reportsHandled.length).toBe(reportsBefore);

    // De novo: nada a reenviar (auditoria), a permanent continua pulada
    await expect(
      redriver.redrive({ group: 'notifications', requestedBy: 'ana' }),
    ).resolves.toEqual({
      read: 2,
      redriven: 0,
      alreadyRedriven: 1,
      skipped: 1,
    });

    // Com a flag, a permanent sai, falha igual (o contrato não mudou) e volta ao DLT
    await expect(
      redriver.redrive({
        group: 'notifications',
        includePermanent: true,
        requestedBy: 'ana',
      }),
    ).resolves.toEqual({
      read: 2,
      redriven: 1,
      alreadyRedriven: 1,
      skipped: 0,
    });
    await waitFor(
      async () => (await messagesIn(NOTIFICATIONS_DLT)) === 3,
      'a permanent voltar ao DLT',
    );
    expect(await prisma.notification.count({ where: { taskId } })).toBe(1);
  });
});
