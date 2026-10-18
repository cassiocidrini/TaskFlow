import { PrismaClient } from '@prisma/client';
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
  });

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
      const novaVersao = await eventStore.append(evento('task-1', 'TaskCreated', { title: 'Minha tarefa' }), 0);

      const events = await prisma.event.findMany();
      expect(novaVersao).toBe(1);
      expect(events).toHaveLength(1);
      expect(events[0].version).toBe(1);
      expect(events[0].eventType).toBe('TaskCreated');
      expect(events[0].aggregateId).toBe('task-1');
    });

    it('deve gravar eventos sequenciais quando cada append informa a versão correta', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1);
      await eventStore.append(evento('task-1', 'TaskCompleted'), 2);

      const events = await eventStore.loadEvents('task-1');
      expect(events.map((e) => e.version)).toEqual([1, 2, 3]);
    });

    it('deve versionar agregados independentes separadamente', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);
      await eventStore.append(evento('task-2', 'TaskCreated'), 0);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1);

      const task1 = await eventStore.loadEvents('task-1');
      const task2 = await eventStore.loadEvents('task-2');
      expect(task1.map((e) => e.version)).toEqual([1, 2]);
      expect(task2.map((e) => e.version)).toEqual([1]);
    });

    it('deve persistir o payload JSON corretamente', async () => {
      const payload = { title: 'Minha tarefa', assigneeId: 'u1', priority: 5, tags: ['urgente', 'bug'] };

      await eventStore.append(evento('task-1', 'TaskCreated', payload), 0);

      const event = await prisma.event.findFirst({ where: { aggregateId: 'task-1' } });
      expect(event!.payload).toEqual(payload);
    });

    it('deve rejeitar expectedVersion negativa ou fracionária', async () => {
      await expect(eventStore.append(evento('task-1', 'TaskCreated'), -1)).rejects.toThrow('expectedVersion inválida');
      await expect(eventStore.append(evento('task-1', 'TaskCreated'), 1.5)).rejects.toThrow('expectedVersion inválida');
    });
  });

  // ============================================================
  // Concorrência otimista — o motivo deste bloco existir
  // ============================================================
  describe('concorrência otimista', () => {
    it('deve lançar ConcurrencyConflictError quando a versão esperada já foi ultrapassada', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1);

      // Um comando que leu o agregado na versão 1 (desatualizado) tenta gravar
      await expect(eventStore.append(evento('task-1', 'TaskCompleted'), 1)).rejects.toThrow(
        ConcurrencyConflictError,
      );

      // E nada foi corrompido: continuam exatamente 2 eventos, versões 1 e 2
      const events = await eventStore.loadEvents('task-1');
      expect(events.map((e) => e.version)).toEqual([1, 2]);
    });

    it('deve aceitar EXATAMENTE UM de N appends simultâneos na mesma versão (race condition real)', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);

      // 10 "requisições" leram o agregado na versão 1 e gravam AO MESMO TEMPO
      const tentativas = Array.from({ length: 10 }, (_, i) =>
        eventStore.append(evento('task-1', 'TaskUpdated', { tentativa: i }), 1),
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
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);

      const novaVersao = await eventStore.appendMany(
        [evento('task-1', 'TaskAssigned'), evento('task-1', 'TaskStatusChanged'), evento('task-1', 'TaskCompleted')],
        1,
      );

      const events = await eventStore.loadEvents('task-1');
      expect(novaVersao).toBe(4);
      expect(events.map((e) => [e.version, e.eventType])).toEqual([
        [1, 'TaskCreated'],
        [2, 'TaskAssigned'],
        [3, 'TaskStatusChanged'],
        [4, 'TaskCompleted'],
      ]);
    });

    it('deve ser ATÔMICO: se uma versão conflitar, NENHUM evento do lote é gravado', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);
      await eventStore.append(evento('task-1', 'TaskAssigned'), 1); // ocupa a versão 2

      // Lote desatualizado: tentaria gravar v2 (conflito) e v3 (livre)
      await expect(
        eventStore.appendMany([evento('task-1', 'TaskStatusChanged'), evento('task-1', 'TaskCompleted')], 1),
      ).rejects.toThrow(ConcurrencyConflictError);

      // A v3 NÃO pode ter entrado sozinha — o agregado não fica "meio salvo"
      const events = await eventStore.loadEvents('task-1');
      expect(events.map((e) => e.version)).toEqual([1, 2]);
    });

    it('deve ser no-op com lista vazia (retorna a mesma versão, sem tocar no banco)', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);

      await expect(eventStore.appendMany([], 1)).resolves.toBe(1);
      expect(await eventStore.loadEvents('task-1')).toHaveLength(1);
    });
  });

  // ============================================================
  // loadEvents
  // ============================================================
  describe('loadEvents', () => {
    it('deve carregar os eventos em ordem cronológica (versão asc)', async () => {
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);
      await eventStore.append(evento('task-1', 'TaskUpdated'), 1);

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
      await eventStore.append(evento('task-1', 'TaskCreated'), 0);
      await eventStore.append(evento('task-2', 'TaskCreated'), 0);

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
      await eventStore.append(evento('task-1', 'TaskCreated', { title: 'Tarefa original' }), 0);
      await eventStore.append(evento('task-1', 'TaskUpdated', { title: 'Tarefa atualizada' }), 1);
      await eventStore.append(evento('task-1', 'TaskCompleted', { completedAt: '2026-10-12T00:00:00Z' }), 2);

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
