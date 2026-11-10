/**
 * Relay da outbox contra PostgreSQL REAL (Testcontainers), com um publisher FALSO no lugar do Kafka — Módulo 13.3.
 *
 * O que só um banco real prova:
 * - o advisory lock de transação: com o lock em uso por outra transação, o relay devolve `busy` e não publica;
 * - DUAS réplicas rodando ao mesmo tempo sobre 200 mensagens de 5 tarefas: cada mensagem sai EXATAMENTE uma vez e,
 *   por tarefa, em ordem de versão (a garantia que o `SKIP LOCKED` não daria);
 * - falha no envio: `attempts`/`last_error` gravados (COMMIT, não rollback) e a linha continua pendente;
 * - a limpeza apaga só as publicadas além da retenção (em UTC), nunca as pendentes;
 * - a métrica da fila (`pendingStats`) mede a idade da pendente mais antiga.
 *
 * O caminho até o Kafka de verdade (chave, partição, headers) está na suíte `test:streaming`.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import type { RelayEnv } from '../../src/config/relay-env.schema';
import {
  MessagePublisher,
  type OutgoingMessage,
} from '../../src/outbox-relay/message-publisher';
import {
  OutboxRelay,
  type CycleOutcome,
} from '../../src/outbox-relay/outbox-relay.service';
import { OutboxStore } from '../../src/outbox-relay/outbox.store';
import { startTestDatabase, TestDatabase } from './support/test-database';

/** Publisher falso que "demora" um pouco, para as duas réplicas realmente se sobreporem */
class RecordingPublisher extends MessagePublisher {
  readonly sent: OutgoingMessage[] = [];
  failWith?: Error;
  constructor(private readonly latencyMs = 0) {
    super();
  }
  async publish(messages: readonly OutgoingMessage[]): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
    if (this.failWith) throw this.failWith;
    this.sent.push(...messages);
  }
}

describe('Relay da outbox (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let store: OutboxStore;

  const config = (batchSize = 10) =>
    ({
      get: (key: keyof RelayEnv) =>
        ({
          OUTBOX_POLL_INTERVAL_MS: 50,
          OUTBOX_BATCH_SIZE: batchSize,
          OUTBOX_RETENTION_HOURS: 72,
        })[key as string],
    }) as unknown as ConfigService<RelayEnv, true>;

  /** Grava N linhas pendentes, na ordem, como o Event Store faria */
  const seed = async (rows: { key: string; version: number }[]) => {
    for (const { key, version } of rows) {
      const eventId = randomUUID();
      await prisma.outboxMessage.create({
        data: {
          eventId,
          topic: 'taskflow.task-events.v1',
          messageKey: key,
          eventType: 'TaskAssigned',
          payload: { eventId, aggregateId: key, aggregateVersion: version },
        },
      });
    }
  };

  /** Roda rodadas até a outbox esvaziar (ou desistir), devolvendo os resultados de cada uma */
  const drain = async (relay: OutboxRelay): Promise<CycleOutcome[]> => {
    const outcomes: CycleOutcome[] = [];
    for (let i = 0; i < 500; i++) {
      const outcome = await relay.runCycle();
      outcomes.push(outcome);
      if (outcome.kind === 'published' && outcome.count === 0) break;
    }
    return outcomes;
  };

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    store = new OutboxStore(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "outbox" RESTART IDENTITY');
  });

  it('deve publicar em ordem de id e marcar published_at', async () => {
    await seed([
      { key: 'task-1', version: 1 },
      { key: 'task-2', version: 1 },
      { key: 'task-1', version: 2 },
    ]);
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay(store, publisher, config());

    await expect(relay.runCycle()).resolves.toEqual({
      kind: 'published',
      count: 3,
    });

    expect(
      publisher.sent.map((m) => [m.key, JSON.parse(m.value).aggregateVersion]),
    ).toEqual([
      ['task-1', 1],
      ['task-2', 1],
      ['task-1', 2],
    ]);
    expect(
      await prisma.outboxMessage.count({ where: { publishedAt: null } }),
    ).toBe(0);
  });

  it('lock em uso por outra transação: busy, nada publicado', async () => {
    await seed([{ key: 'task-1', version: 1 }]);
    const publisher = new RecordingPublisher();
    const relay = new OutboxRelay(store, publisher, config());

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // Outra "réplica": segura o MESMO advisory lock dentro de uma transação aberta
    const other = prisma.$transaction(async (tx) => {
      // $executeRaw: a função devolve void, que o $queryRaw não sabe desserializar
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('taskflow.outbox-relay'))`;
      locked();
      await held;
    });
    await lockTaken;

    await expect(relay.runCycle()).resolves.toEqual({ kind: 'busy' });
    expect(publisher.sent).toHaveLength(0);

    release();
    await other; // COMMIT da outra transação solta o lock sozinho
    await expect(relay.runCycle()).resolves.toEqual({
      kind: 'published',
      count: 1,
    });
  });

  it('duas réplicas simultâneas: cada mensagem sai exatamente uma vez e em ordem por tarefa', async () => {
    const keys = ['task-a', 'task-b', 'task-c', 'task-d', 'task-e'];
    const rows = Array.from({ length: 40 }, (_, i) => i + 1).flatMap(
      (version) => keys.map((key) => ({ key, version })),
    );
    await seed(rows); // 200 linhas, intercaladas entre as 5 tarefas

    // As duas compartilham o registro de envio: a ordem global de publicação fica visível
    const publisher = new RecordingPublisher(5);
    const relayA = new OutboxRelay(store, publisher, config(7));
    const relayB = new OutboxRelay(store, publisher, config(7));

    const [outcomesA, outcomesB] = await Promise.all([
      drain(relayA),
      drain(relayB),
    ]);

    // Houve disputa de verdade (senão o teste não provaria nada) e as duas publicaram
    const busy = [...outcomesA, ...outcomesB].filter((o) => o.kind === 'busy');
    expect(busy.length).toBeGreaterThan(0);
    const published = (outcomes: CycleOutcome[]) =>
      outcomes.reduce(
        (sum, o) => sum + (o.kind === 'published' ? o.count : 0),
        0,
      );
    expect(published(outcomesA)).toBeGreaterThan(0);
    expect(published(outcomesB)).toBeGreaterThan(0);

    // Exatamente uma vez
    const eventIds = publisher.sent.map((m) => m.headers['event-id']);
    expect(eventIds).toHaveLength(200);
    expect(new Set(eventIds).size).toBe(200);

    // Em ordem por tarefa: as versões de cada chave chegam 1, 2, 3, … 40
    for (const key of keys) {
      const versions = publisher.sent
        .filter((m) => m.key === key)
        .map((m) => JSON.parse(m.value).aggregateVersion as number);
      expect(versions).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    }
  });

  it('falha no envio: attempts e last_error gravados, linha continua pendente; depois publica', async () => {
    await seed([
      { key: 'task-1', version: 1 },
      { key: 'task-1', version: 2 },
    ]);
    const publisher = new RecordingPublisher();
    publisher.failWith = new Error('Local: Message timed out');
    const relay = new OutboxRelay(store, publisher, config());

    await relay.runCycle();
    await relay.runCycle();

    const failed = await prisma.outboxMessage.findMany({
      orderBy: { id: 'asc' },
    });
    expect(failed.map((r) => [r.publishedAt, r.attempts, r.lastError])).toEqual(
      [
        [null, 2, 'Local: Message timed out'],
        [null, 2, 'Local: Message timed out'],
      ],
    );

    publisher.failWith = undefined;
    await expect(relay.runCycle()).resolves.toEqual({
      kind: 'published',
      count: 2,
    });
    // attempts fica como registro do incidente
    expect(
      (await prisma.outboxMessage.findMany()).every(
        (r) => r.publishedAt && r.attempts === 2,
      ),
    ).toBe(true);
  });

  it('limpeza: apaga só as publicadas além da retenção; pendentes nunca', async () => {
    await seed([
      { key: 'antiga', version: 1 },
      { key: 'recente', version: 1 },
      { key: 'pendente-antiga', version: 1 },
    ]);
    // Datas em UTC, como o Prisma grava
    await prisma.$executeRaw`UPDATE outbox SET published_at = (now() AT TIME ZONE 'UTC') - interval '100 hours' WHERE message_key = 'antiga'`;
    await prisma.$executeRaw`UPDATE outbox SET published_at = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE message_key = 'recente'`;
    await prisma.$executeRaw`UPDATE outbox SET created_at = (now() AT TIME ZONE 'UTC') - interval '200 hours' WHERE message_key = 'pendente-antiga'`;

    await expect(store.deletePublishedOlderThan(72)).resolves.toBe(1);

    const restantes = await prisma.outboxMessage.findMany({
      orderBy: { id: 'asc' },
    });
    expect(restantes.map((r) => r.messageKey)).toEqual([
      'recente',
      'pendente-antiga',
    ]);
  });

  it('pendingStats: quantidade e idade da pendente mais antiga (0 com a fila vazia)', async () => {
    await expect(store.pendingStats()).resolves.toEqual({
      pending: 0,
      oldestAgeSeconds: 0,
    });

    await seed([
      { key: 'task-1', version: 1 },
      { key: 'task-2', version: 1 },
    ]);
    await prisma.$executeRaw`UPDATE outbox SET created_at = (now() AT TIME ZONE 'UTC') - interval '90 seconds' WHERE message_key = 'task-1'`;

    const stats = await store.pendingStats();
    expect(stats.pending).toBe(2);
    expect(stats.oldestAgeSeconds).toBeGreaterThanOrEqual(90);
    expect(stats.oldestAgeSeconds).toBeLessThan(120);
  });
});
