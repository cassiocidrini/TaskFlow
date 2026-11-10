/**
 * Retry e dead-letter topic com Kafka e PostgreSQL REAIS — Módulo 13.5.
 *
 * Protege o que o DLT promete, e o que ele NÃO pode fazer:
 * - mensagem envenenada (contrato violado) vai ao DLT na 1ª falha, intacta e com o diagnóstico nos headers, e a
 *   PARTIÇÃO SEGUE; depois de um restart, ela não volta;
 * - o custo da escolha, medido: o `TaskCompleted` seguinte passa sem o `TaskAssigned` desviado, e ninguém é
 *   notificado (ordem trocada por disponibilidade);
 * - falha desconhecida: `maxAttempts` tentativas e então DLT (`dlt-reason: exhausted`);
 * - falha de banco: passa do limite de tentativas e NÃO vai ao DLT;
 * - DLT indisponível: a mensagem NÃO sai da partição (commitar sem o ack do DLT a perderia), e vai quando o DLT volta.
 *
 * Cada teste usa tópicos próprios: um grupo novo lê do início, e veria as mensagens dos testes anteriores.
 */
import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { Logger } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  KafkaConsumerRunner,
  type ConsumedMessage,
  type HandleResult,
  type KafkaConsumerOptions,
} from '../../src/common/messaging/kafka-consumer.runner';
import { NotificationsHandler } from '../../src/modules/notifications/consumer/notifications.handler';
import {
  startTestDatabase,
  type TestDatabase,
} from '../integration/support/test-database';
import { startTestKafka, type TestKafka } from './support/kafka-container';

interface ReadMessage {
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

describe('Retry e dead-letter topic (streaming)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let kafka: TestKafka;
  let client: KafkaJS.Kafka;
  let admin: KafkaJS.Admin;
  let producer: KafkaJS.Producer;
  let handler: NotificationsHandler;
  const runners: KafkaConsumerRunner[] = [];

  const OWNER = randomUUID();
  const PROJECT = randomUUID();
  const logger = new Logger('dlt-test');

  /** Logger que guarda os erros do runner: o teste espera a FALHA acontecer, em vez de dormir um tempo fixo */
  class CapturingLogger extends Logger {
    readonly errors: string[] = [];
    override error(message: unknown, ...rest: unknown[]): void {
      this.errors.push(
        typeof message === 'string'
          ? message
          : String((message as { msg?: unknown }).msg),
      );
      super.error(message, ...rest);
    }
  }

  /** Tópico de origem e DLT novos, só deste teste */
  const freshTopics = async () => {
    const id = randomUUID().slice(0, 8);
    const source = `test.source-${id}.v1`;
    const dlt = `test.dlt-${id}.v1`;
    await admin.createTopics({
      topics: [
        { topic: source, numPartitions: 3 },
        { topic: dlt, numPartitions: 3 },
      ],
    });
    return { source, dlt };
  };

  /** Mensagem como o relay a publica: chave = taskId, envelope do contrato, headers do relay */
  const event = (
    taskId: string,
    eventType: string,
    data: Record<string, unknown>,
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
        aggregateVersion: 1,
        projectId: PROJECT,
        actorId: OWNER,
        data,
      }),
      headers: { 'event-id': eventId, 'event-type': eventType },
    };
  };

  const publish = (topic: string, messages: ReturnType<typeof event>[]) =>
    producer.send({ topic, messages });

  const startRunner = async (
    options: Pick<KafkaConsumerOptions, 'groupId' | 'handle'> &
      Partial<KafkaConsumerOptions> & { topic: string; dlt: string },
  ) => {
    const runner = new KafkaConsumerRunner({
      brokers: kafka.brokers,
      topics: [options.topic],
      deadLetterTopic: options.dlt,
      acceptsReplay: true,
      partitionsConsumedConcurrently: 3,
      logger,
      ...options,
    });
    runners.push(runner);
    await runner.start();
    return runner;
  };

  /** Mensagens no tópico, pelo high watermark (soma das partições): sem consumir, sem esperar */
  const countIn = async (topic: string) =>
    (await admin.fetchTopicOffsets(topic)).reduce(
      (total, p) => total + Number(p.high),
      0,
    );

  /** Lê o tópico do início com um grupo descartável até ter `count` mensagens */
  const readAll = async (topic: string, count: number) => {
    const read: ReadMessage[] = [];
    const reader = client.consumer({
      kafkaJS: { groupId: `reader-${randomUUID()}`, fromBeginning: true },
    });
    await reader.connect();
    await reader.subscribe({ topics: [topic] });
    await reader.run({
      eachMessage: async ({ message }) => {
        read.push({
          key: message.key?.toString() ?? null,
          value: message.value?.toString() ?? null,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([k, v]) => [
              k,
              String(v),
            ]),
          ),
        });
      },
    });
    await waitFor(
      () => read.length >= count,
      `${count} mensagem(ns) em ${topic}`,
    );
    await reader.disconnect();
    return read;
  };

  beforeAll(async () => {
    [db, kafka] = await Promise.all([startTestDatabase(), startTestKafka()]);
    prisma = db.prisma;
    handler = new NotificationsHandler(prisma as never);
    client = new KafkaJS.Kafka({
      kafkaJS: { brokers: kafka.brokers, logLevel: KafkaJS.logLevel.ERROR },
    });
    admin = client.admin();
    await admin.connect();
    producer = client.producer();
    await producer.connect();
  }, 180_000);

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.stop()));
  });

  afterAll(async () => {
    await producer?.disconnect();
    await admin?.disconnect();
    await Promise.all([db?.stop(), kafka?.stop()]);
  });

  it('mensagem envenenada: DLT na 1ª falha, intacta e com diagnóstico; a partição segue e um restart não a traz de volta', async () => {
    const { source, dlt } = await freshTopics();
    const taskId = randomUUID();
    const poison = event(taskId, 'TaskAssigned', { assigneeId: 'nao-e-uuid' });
    // Copiados ANTES do send: o cliente converte os headers da mensagem enviada para o formato interno, in place
    const poisonValue = poison.value;
    const poisonEventId = poison.headers['event-id'];
    // Mesma chave = mesma partição: o Completed vem DEPOIS da mensagem envenenada
    await publish(source, [
      event(taskId, 'TaskCreated', { title: 'Conciliar pagamentos' }),
      poison,
      event(taskId, 'TaskCompleted', { completedAt: new Date().toISOString() }),
    ]);

    const results: HandleResult[] = [];
    const attempts: string[] = [];
    const handle = async (message: ConsumedMessage) => {
      attempts.push(message.headers['event-type']);
      return handler.handle(message);
    };
    const runner = await startRunner({
      groupId: 'notifications-poison',
      topic: source,
      dlt,
      handle: async (m) => {
        const r = await handle(m);
        results.push(r);
        return r;
      },
    });
    await waitFor(() => results.length === 2, 'Created e Completed');

    // Uma tentativa só da envenenada (permanente), e o Completed passou depois dela
    expect(attempts).toEqual(['TaskCreated', 'TaskAssigned', 'TaskCompleted']);
    const [dead] = await readAll(dlt, 1);
    expect(dead.key).toBe(taskId);
    expect(dead.value).toBe(poisonValue); // byte a byte
    expect(dead.headers).toMatchObject({
      'event-id': poisonEventId,
      'event-type': 'TaskAssigned',
      'dlt-original-topic': source,
      'dlt-consumer-group': 'notifications-poison',
      'dlt-reason': 'permanent',
      'dlt-attempts': '1',
    });
    expect(dead.headers['dlt-error-message']).toContain(
      'TaskAssigned inválido',
    );
    expect(dead.headers['dlt-error-message']).not.toMatch(/\n/); // uma linha: o erro do zod tem quebras
    expect(dead.headers['dlt-original-offset']).toBe('1');

    // O custo da escolha: o Completed foi processado, mas sem o Assigned ninguém sabe quem notificar
    expect(await prisma.notification.count({ where: { taskId } })).toBe(0);

    // Restart do mesmo grupo: o offset da envenenada foi commitado (só depois do ack do DLT); ela não volta
    await runner.stop();
    runners.splice(runners.indexOf(runner), 1);
    attempts.length = 0;
    const later = event(randomUUID(), 'TaskCreated', {
      title: 'Depois do restart',
    });
    await publish(source, [later]);
    await startRunner({
      groupId: 'notifications-poison',
      topic: source,
      dlt,
      handle,
    });
    await waitFor(() => attempts.length === 1, 'a mensagem nova');
    expect(attempts).toEqual(['TaskCreated']);
  });

  it(`falha desconhecida: tenta maxAttempts vezes e então DLT (exhausted)`, async () => {
    const { source, dlt } = await freshTopics();
    const taskId = randomUUID();
    await publish(source, [
      event(taskId, 'TaskCreated', { title: 'Sempre falha' }),
      event(taskId, 'TaskCompleted', { completedAt: new Date().toISOString() }),
    ]);

    const seen: string[] = [];
    let attempts = 0;
    await startRunner({
      groupId: 'unknown-failure',
      topic: source,
      dlt,
      maxAttempts: 3,
      handle: async (m) => {
        if (m.headers['event-type'] === 'TaskCreated') {
          attempts++;
          throw new TypeError('bug no handler');
        }
        seen.push(m.headers['event-type']);
        return 'processed';
      },
    });
    await waitFor(() => seen.length === 1, 'a mensagem seguinte', 30_000);

    expect(attempts).toBe(3); // 500 ms + 1 s de espera entre elas
    const [dead] = await readAll(dlt, 1);
    expect(dead.headers).toMatchObject({
      'dlt-reason': 'exhausted',
      'dlt-attempts': '3',
      'dlt-error-message': 'bug no handler',
    });
  });

  it('falha de banco: passa do limite de tentativas e NÃO vai ao DLT', async () => {
    const { source, dlt } = await freshTopics();
    await publish(source, [
      event(randomUUID(), 'TaskCreated', { title: 'Banco fora' }),
    ]);

    let attempts = 0;
    const results: HandleResult[] = [];
    await startRunner({
      groupId: 'db-outage',
      topic: source,
      dlt,
      maxAttempts: 2,
      handle: async () => {
        // O formato real do Prisma com o banco inalcançável, 4 vezes (o dobro do limite), depois o banco "volta"
        if (++attempts <= 4) {
          throw new Prisma.PrismaClientKnownRequestError(
            "Can't reach database server",
            {
              code: 'P1001',
              clientVersion: '7.10.0',
              meta: {
                driverAdapterError: { cause: { kind: 'DatabaseNotReachable' } },
              },
            },
          );
        }
        results.push('processed');
        return 'processed';
      },
    });
    await waitFor(() => results.length === 1, 'o banco voltar', 30_000);

    expect(attempts).toBe(5);
    expect(await countIn(dlt)).toBe(0);
  });

  it('DLT indisponível: a mensagem NÃO sai da partição, e vai ao DLT quando ele volta', async () => {
    const id = randomUUID().slice(0, 8);
    const source = `test.source-${id}.v1`;
    const dlt = `test.dlt-missing-${id}.v1`; // ainda não existe (autocriação desligada, como no compose)
    await admin.createTopics({ topics: [{ topic: source, numPartitions: 1 }] });
    const taskId = randomUUID();
    await publish(source, [
      event(taskId, 'TaskAssigned', { assigneeId: 'nao-e-uuid' }),
      event(taskId, 'TaskCreated', { title: 'Atrás da envenenada' }),
    ]);

    const results: HandleResult[] = [];
    const captured = new CapturingLogger('dlt-test');
    await startRunner({
      groupId: 'dlt-down',
      topic: source,
      dlt,
      logger: captured,
      handle: async (m) => {
        const r = await handler.handle(m);
        results.push(r);
        return r;
      },
    });

    // Espera o envio ao DLT FALHAR de verdade (timeout de 10 s num tópico que não existe). Dormir um tempo fixo
    // não servia: o join do grupo atrasa o 1º envio, o tópico era criado antes do timeout, e o teste passava sem
    // nunca exercitar a falha (a mutação "commitar sem o ack do DLT" sobrevivia)
    await waitFor(
      () =>
        captured.errors.some((e) => e.includes('ao enviar ao DLT')) ||
        results.length > 0, // ou algo furou a fila: a asserção abaixo mostra o quê
      'a falha do envio ao DLT',
      40_000,
    );
    expect(results).toEqual([]); // nada atrás da envenenada passou

    await admin.createTopics({ topics: [{ topic: dlt, numPartitions: 1 }] });
    await waitFor(() => results.length === 1, 'o DLT voltar', 60_000);
    expect(results).toEqual(['processed']);
    expect(await countIn(dlt)).toBe(1);
  }, 120_000);
});

async function waitFor(
  predicate: () => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timeout esperando: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
