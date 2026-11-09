/**
 * Event Store contra PostgreSQL REAL (Testcontainers).
 *
 * Mock prova intenção; integração prova EFEITO. Atomicidade e concorrência só existem no banco:
 * - 10 `append` SIMULTÂNEOS na mesma versão → exatamente 1 sucesso e 9 `ConcurrencyConflictError` (a race
 *   condition real, fechada pelo `UNIQUE (aggregate_id, version)`);
 * - `appendMany` com uma versão em conflito → NENHUM evento do lote é gravado (um INSERT, tudo ou nada);
 * - replay reconstruindo o estado a partir dos eventos;
 * - envelope de metadados: `eventId` único gerado antes do INSERT (o retorno bate com o gravado), `actorId`,
 *   `correlationId` da requisição (e ausente fora dela), `schemaVersion`; evento legado (`{}`) continua legível.
 *
 * `Promise.allSettled` (e não `all`): espera TODAS as tentativas e confere que falharam com o erro CERTO.
 */
import { PrismaClient } from '@prisma/client';
import { runWithCorrelationId } from '../../src/common/correlation/correlation-context';
import { toEventMetadata } from '../../src/events/event-metadata';
import {
  ConcurrencyConflictError,
  DomainEvent,
  EventStoreService,
} from '../../src/events/event-store.service';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('EventStoreService (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let eventStore: EventStoreService;

  // Fábrica de eventos para reduzir ruído nos testes
  const evento = (aggregateId: string, eventType: string, payload: Record<string, unknown> = {}): DomainEvent => ({
    aggregateId,
    aggregateType: 'Task',
    eventType,
    payload,
    schemaVersion: 1,
  });

  // Todo append exige o autor (actorId): sem ele, o evento não teria auditoria
  const ator = { actorId: 'user-1' };

  beforeAll(async () => {
    // Postgres real + migrações (inclui o UNIQUE (aggregate_id, version))
    db = await startTestDatabase();
    prisma = db.prisma;
    eventStore = new EventStoreService(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.event.deleteMany();
  });

  // ============================================================
  // append
  // ============================================================
  describe('append', () => {
    it('deve persistir o primeiro evento na versão 1 e retornar a nova versão', async () => {
      const novaVersao = await eventStore.append(evento('task-1', 'TaskCreated', { title: 'Minha tarefa' }), 0, ator);

      const events = await prisma.event.findMany();
      expect(novaVersao.version).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0].version).toBe(1);
      expect(events[0].eventType).toBe('TaskCreated');
      expect(events[0].aggregateId).toBe('task-1');
    });

    it('deve gravar eventos sequenciais quando cada append informa a versão correta', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1, ator);
      await eventStore.append(evento('task-1', 'TaskCompleted'), 2, ator);

      const events = await eventStore.loadEvents('task-1');
      expect(events.map((e) => e.version)).toEqual([1, 2, 3]);
    });

    it('deve versionar agregados independentes separadamente', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);
      await eventStore.append(evento('task-2', 'TaskCreated'), 0, ator);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1, ator);

      const task1 = await eventStore.loadEvents('task-1');
      const task2 = await eventStore.loadEvents('task-2');
      expect(task1.map((e) => e.version)).toEqual([1, 2]);
      expect(task2.map((e) => e.version)).toEqual([1]);
    });

    it('deve persistir o payload JSON corretamente', async () => {
      const payload = { title: 'Minha tarefa', assigneeId: 'u1', priority: 5, tags: ['urgente', 'bug'] };

      await eventStore.append(evento('task-1', 'TaskCreated', payload), 0, ator);

      const event = await prisma.event.findFirst({ where: { aggregateId: 'task-1' } });
      expect(event!.payload).toEqual(payload);
    });

    it('deve rejeitar expectedVersion negativa ou fracionária', async () => {
      await expect(eventStore.append(evento('task-1', 'TaskCreated'), -1, ator)).rejects.toThrow('expectedVersion inválida');
      await expect(eventStore.append(evento('task-1', 'TaskCreated'), 1.5, ator)).rejects.toThrow('expectedVersion inválida');
    });
  });

  // ============================================================
  // Concorrência otimista — o motivo deste bloco existir
  // ============================================================
  describe('concorrência otimista', () => {
    it('deve lançar ConcurrencyConflictError quando a versão esperada já foi ultrapassada', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1, ator);

      // Um comando que leu o agregado na versão 1 (desatualizado) tenta gravar
      await expect(eventStore.append(evento('task-1', 'TaskCompleted'), 1, ator)).rejects.toThrow(
        ConcurrencyConflictError,
      );

      // E nada foi corrompido: continuam exatamente 2 eventos, versões 1 e 2
      const events = await eventStore.loadEvents('task-1');
      expect(events.map((e) => e.version)).toEqual([1, 2]);
    });

    it('deve aceitar EXATAMENTE UM de N appends simultâneos na mesma versão (race condition real)', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);

      // 10 "requisições" leram o agregado na versão 1 e gravam AO MESMO TEMPO
      const tentativas = Array.from({ length: 10 }, (_, i) =>
        eventStore.append(evento('task-1', 'TaskUpdated', { tentativa: i }), 1, ator),
      );
      const resultados = await Promise.allSettled(tentativas);

      const sucessos = resultados.filter((r) => r.status === 'fulfilled');
      const conflitos = resultados.filter(
        (r) => r.status === 'rejected' && r.reason instanceof ConcurrencyConflictError,
      );

      expect(sucessos).toHaveLength(1); // só um vence
      expect(conflitos).toHaveLength(9); // todos os outros recebem 409 — nenhum erro "estranho"

      const events = await eventStore.loadEvents('task-1');
      expect(events.map((e) => e.version)).toEqual([1, 2]); // sem versões duplicadas
    });
  });

  // ============================================================
  // appendMany — vários eventos de um comando, tudo ou nada
  // ============================================================
  describe('appendMany', () => {
    it('deve gravar N eventos em versões consecutivas e retornar a versão final', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);

      const novaVersao = await eventStore.appendMany(
        [evento('task-1', 'TaskAssigned'), evento('task-1', 'TaskStatusChanged'), evento('task-1', 'TaskCompleted')],
        1,
        ator,
      );

      const events = await eventStore.loadEvents('task-1');
      expect(novaVersao.version).toBe(4);
      expect(events.map((e) => [e.version, e.eventType])).toEqual([
        [1, 'TaskCreated'],
        [2, 'TaskAssigned'],
        [3, 'TaskStatusChanged'],
        [4, 'TaskCompleted'],
      ]);
    });

    it('deve ser ATÔMICO: se uma versão conflitar, NENHUM evento do lote é gravado', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);
      await eventStore.append(evento('task-1', 'TaskAssigned'), 1, ator); // ocupa a versão 2

      // Lote desatualizado: tentaria gravar v2 (conflito) e v3 (livre)
      await expect(
        eventStore.appendMany([evento('task-1', 'TaskStatusChanged'), evento('task-1', 'TaskCompleted')], 1, ator),
      ).rejects.toThrow(ConcurrencyConflictError);

      // A v3 NÃO pode ter entrado sozinha — o agregado não fica "meio salvo"
      const events = await eventStore.loadEvents('task-1');
      expect(events.map((e) => e.version)).toEqual([1, 2]);
    });

    it('deve ser no-op com lista vazia (retorna a mesma versão, sem tocar no banco)', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);

      await expect(eventStore.appendMany([], 1, ator)).resolves.toEqual({ version: 1, metadata: [] });
      expect(await eventStore.loadEvents('task-1')).toHaveLength(1);
    });
  });

  // ============================================================
  // Envelope de metadados (eventId, actorId, correlationId, schemaVersion)
  // ============================================================
  describe('metadata', () => {
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

    it('deve gravar o envelope de cada evento e devolver EXATAMENTE o que gravou', async () => {
      const resultado = await runWithCorrelationId('chamado-1234', () =>
        eventStore.appendMany(
          [evento('task-1', 'TaskCreated'), { ...evento('task-1', 'TaskAssigned'), schemaVersion: 2 }],
          0,
          ator,
        ),
      );

      const gravados = (await eventStore.loadEvents('task-1')).map((e) => e.metadata);
      expect(gravados).toEqual(resultado.metadata);
      expect(gravados[0]).toEqual({
        eventId: expect.stringMatching(UUID),
        actorId: 'user-1',
        correlationId: 'chamado-1234',
        schemaVersion: 1,
      });
      expect(resultado.metadata[1].schemaVersion).toBe(2);
    });

    it('deve gerar um eventId DIFERENTE para cada evento do lote', async () => {
      const { metadata } = await eventStore.appendMany(
        [evento('task-1', 'TaskCreated'), evento('task-1', 'TaskAssigned'), evento('task-1', 'TaskCompleted')],
        0,
        ator,
      );

      expect(new Set(metadata.map((m) => m.eventId)).size).toBe(3);
    });

    it('deve omitir o correlationId quando o evento nasce fora de uma requisição (sem inventar valor)', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);

      const [event] = await eventStore.loadEvents('task-1');
      expect(event.metadata).not.toHaveProperty('correlationId');
    });

    it('deve ler um evento legado, gravado antes da coluna metadata, como {} (sem autor)', async () => {
      // Simula uma linha anterior à migração: o INSERT não informa metadata e o DEFAULT do banco preenche
      await prisma.$executeRaw`
        INSERT INTO events (id, aggregate_id, aggregate_type, event_type, payload, version)
        VALUES (gen_random_uuid(), 'task-legado', 'Task', 'TaskCreated', '{}'::jsonb, 1)`;

      const [event] = await eventStore.loadEvents('task-legado');
      expect(event.metadata).toEqual({});
      expect(toEventMetadata(event.metadata)).toEqual({});
    });
  });

  // ============================================================
  // loadEvents
  // ============================================================
  describe('loadEvents', () => {
    it('deve carregar os eventos em ordem cronológica (versão asc)', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1, ator);

      const events = await eventStore.loadEvents('task-1');

      expect(events).toHaveLength(2);
      expect(events[0].eventType).toBe('TaskCreated');
      expect(events[1].eventType).toBe('TaskUpdated');
    });

    it('deve retornar array vazio se o agregado não tem eventos', async () => {
      const events = await eventStore.loadEvents('task-inexistente');
      expect(events).toEqual([]);
    });

    it('deve filtrar apenas os eventos do agregado correto', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0, ator);
      await eventStore.append(evento('task-2', 'TaskCreated'), 0, ator);

      const events = await eventStore.loadEvents('task-1');
      expect(events).toHaveLength(1);
      expect(events[0].aggregateId).toBe('task-1');
    });
  });

  // ============================================================
  // Replay (reconstrução de estado)
  // ============================================================
  describe('replay (reconstrução de estado)', () => {
    it('deve reconstruir o estado atual a partir dos eventos', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated', { title: 'Tarefa original' }), 0, ator);
      await eventStore.append(evento('task-1', 'TaskUpdated', { title: 'Tarefa atualizada' }), 1, ator);
      await eventStore.append(evento('task-1', 'TaskCompleted', { completedAt: '2026-10-12T00:00:00Z' }), 2, ator);

      const events = await eventStore.loadEvents('task-1');

      let state: { title?: string; completed?: boolean } = {};
      for (const event of events) {
        const payload = event.payload as Record<string, unknown>;
        if (event.eventType === 'TaskCreated') {
          state = { title: payload.title as string, completed: false };
        } else if (event.eventType === 'TaskUpdated') {
          state = { ...state, title: payload.title as string };
        } else if (event.eventType === 'TaskCompleted') {
          state = { ...state, completed: true };
        }
      }

      expect(state).toEqual({ title: 'Tarefa atualizada', completed: true });
    });
  });
});
