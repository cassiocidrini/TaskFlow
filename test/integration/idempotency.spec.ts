/**
 * `Idempotency-Key` contra PostgreSQL REAL (Testcontainers) — Módulo 14.5.
 *
 * Protege a decisão central: a chave é gravada NA MESMA transação do `TaskCreated`, e a chave primária
 * `(user_id, key)` é quem decide a corrida. Com o `CreateTaskHandler`, o `EventStoreService` e o `IdempotencyStore`
 * reais (só o EventBus e a posse do projeto simulados):
 * - 10 requisições SIMULTÂNEAS com a mesma chave: UMA tarefa, um evento, uma mensagem na outbox, uma chave, e as 10
 *   respostas com o MESMO `taskId` (9 marcadas como repetição);
 * - a mesma chave num pedido diferente: 422, nada criado;
 * - a mesma chave de dois usuários: duas chaves (a PK é por usuário);
 * - chave vencida: conta como nova;
 * - a gravação da chave falhando (aqui, pela CHECK de tamanho): a transação inteira desfeita, e a TAREFA também não
 *   existe. É a prova de que não há estado intermediário: ou tudo, ou nada.
 */
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { EventBus } from '@nestjs/cqrs';
import { PrismaClient } from '@prisma/client';
import { IdempotencyKeyReusedError } from '../../src/common/idempotency/idempotency-key';
import { IdempotencyStore } from '../../src/common/idempotency/idempotency.store';
import type { Env } from '../../src/config/env.schema';
import { EventStoreService } from '../../src/events/event-store.service';
import { CreateTaskCommand } from '../../src/modules/tasks/commands/create-task.command';
import { CreateTaskHandler } from '../../src/modules/tasks/commands/create-task.handler';
import type { ProjectsService } from '../../src/modules/projects/projects.service';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('Idempotency-Key (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let handler: CreateTaskHandler;

  const PROJECT = randomUUID();

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
    const config = { get: () => 24 } as unknown as ConfigService<Env, true>;
    handler = new CreateTaskHandler(
      new EventStoreService(prisma as never),
      { publish: () => undefined } as unknown as EventBus,
      { assertOwner: () => Promise.resolve() } as unknown as ProjectsService,
      new IdempotencyStore(prisma as never, config),
    );
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE TABLE "idempotency_keys", "events", "outbox"',
    );
  });

  const create = (
    userId: string,
    key: string,
    title = 'Pagar boleto',
    requestHash = `hash:${title}`,
  ) =>
    handler.execute(
      new CreateTaskCommand(userId, PROJECT, title, undefined, undefined, {
        key,
        requestHash,
      }),
    );

  const count = async () => ({
    events: await prisma.event.count({ where: { eventType: 'TaskCreated' } }),
    outbox: await prisma.outboxMessage.count(),
    keys: await prisma.idempotencyKey.count(),
  });

  it('10 requisições SIMULTÂNEAS com a mesma chave: uma tarefa, e todas com o mesmo taskId', async () => {
    const user = randomUUID();
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => create(user, key)),
    );

    expect(new Set(results.map((r) => r.taskId)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(results.filter((r) => r.replayed)).toHaveLength(9);
    expect(await count()).toEqual({ events: 1, outbox: 1, keys: 1 });
  });

  it('nova tentativa depois: a mesma resposta, sem criar nada', async () => {
    const user = randomUUID();
    const first = await create(user, 'k-1');

    const retry = await create(user, 'k-1');

    expect(retry).toEqual({ taskId: first.taskId, replayed: true });
    expect(await count()).toEqual({ events: 1, outbox: 1, keys: 1 });
  });

  it('mesma chave, pedido diferente: 422, nada criado', async () => {
    const user = randomUUID();
    await create(user, 'k-1', 'Pagar boleto');

    await expect(
      create(user, 'k-1', 'Pagar OUTRO boleto'),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
    expect(await count()).toEqual({ events: 1, outbox: 1, keys: 1 });
  });

  it('mesma chave de dois usuários: duas chaves, duas tarefas (a chave é por usuário)', async () => {
    const a = await create(randomUUID(), 'k-compartilhada');
    const b = await create(randomUUID(), 'k-compartilhada');

    expect(a.taskId).not.toBe(b.taskId);
    expect(b.replayed).toBe(false);
    expect(await count()).toEqual({ events: 2, outbox: 2, keys: 2 });
  });

  it('chave vencida (mais de 24 h): conta como nova, e a vencida é substituída na mesma transação', async () => {
    const user = randomUUID();
    const first = await create(user, 'k-velha');
    await prisma.idempotencyKey.updateMany({
      where: { userId: user, key: 'k-velha' },
      data: { createdAt: new Date(Date.now() - 25 * 3_600_000) },
    });

    const again = await create(user, 'k-velha');

    expect(again.replayed).toBe(false);
    expect(again.taskId).not.toBe(first.taskId);
    expect(await count()).toEqual({ events: 2, outbox: 2, keys: 1 });
  });

  it('a chave não pôde ser gravada: a TAREFA também não existe (uma transação só)', async () => {
    // A validação do header barraria esta chave antes; aqui ela chega ao banco de propósito, e a CHECK a recusa
    await expect(create(randomUUID(), 'k'.repeat(256))).rejects.toThrow();

    expect(await count()).toEqual({ events: 0, outbox: 0, keys: 0 });
  });
});
