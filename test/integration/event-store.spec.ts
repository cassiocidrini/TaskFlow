import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { EventStoreService } from '../../src/events/event-store.service';

describe('EventStoreService (integração)', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let eventStore: EventStoreService;

  beforeAll(async () => {
    // 1. Sobe um container Postgres real
    container = await new PostgreSqlContainer('postgres:16-alpine')
      .withDatabase('test_db')
      .withUsername('test')
      .withPassword('test')
      .start();

    // 2. Cria o Prisma Client apontando para o container
    const connectionString = container.getConnectionUri();
    const adapter = new PrismaPg({ connectionString });
    prisma = new PrismaClient({ adapter });

    // 3. Roda as migrações do Prisma
    execSync('npx prisma migrate deploy', {
      env: { ...process.env, DATABASE_URL: connectionString },
      stdio: 'inherit',
    });

    // 4. Instancia o EventStoreService
    eventStore = new EventStoreService(prisma as never);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await container.stop();
  });

  beforeEach(async () => {
    await prisma.event.deleteMany();
  });

  // ============================================================
  // append
  // ============================================================
  describe('append', () => {
    it('deve persistir um evento com versão inicial 1', async () => {
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: { title: 'Minha tarefa' },
      });

      const events = await prisma.event.findMany();
      expect(events).toHaveLength(1);
      expect(events[0].version).toBe(1);
      expect(events[0].eventType).toBe('TaskCreated');
      expect(events[0].aggregateId).toBe('task-1');
    });

    it('deve incrementar a versão ao adicionar múltiplos eventos do mesmo agregado', async () => {
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: { title: 'Tarefa' },
      });
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskUpdated',
        payload: { title: 'Tarefa atualizada' },
      });
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCompleted',
        payload: { completedAt: '2026-10-12T00:00:00Z' },
      });

      const events = await prisma.event.findMany({
        where: { aggregateId: 'task-1' },
        orderBy: { version: 'asc' },
      });

      expect(events).toHaveLength(3);
      expect(events[0].version).toBe(1);
      expect(events[1].version).toBe(2);
      expect(events[2].version).toBe(3);
    });

    it('deve versionar agregados independentes separadamente', async () => {
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: {},
      });
      await eventStore.append({
        aggregateId: 'task-2',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: {},
      });
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskUpdated',
        payload: {},
      });

      const task1Events = await prisma.event.findMany({
        where: { aggregateId: 'task-1' },
        orderBy: { version: 'asc' },
      });
      const task2Events = await prisma.event.findMany({
        where: { aggregateId: 'task-2' },
        orderBy: { version: 'asc' },
      });

      expect(task1Events.map((e) => e.version)).toEqual([1, 2]);
      expect(task2Events.map((e) => e.version)).toEqual([1]);
    });

    it('deve persistir o payload JSON corretamente', async () => {
      const payload = {
        title: 'Minha tarefa',
        assigneeId: 'u1',
        priority: 5,
        tags: ['urgente', 'bug'],
      };

      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload,
      });

      const event = await prisma.event.findFirst({ where: { aggregateId: 'task-1' } });
      expect(event!.payload).toEqual(payload);
    });
  });

  // ============================================================
  // loadEvents
  // ============================================================
  describe('loadEvents', () => {
    it('deve carregar os eventos em ordem cronológica (versão asc)', async () => {
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: {},
      });
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskUpdated',
        payload: {},
      });

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
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: {},
      });
      await eventStore.append({
        aggregateId: 'task-2',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: {},
      });

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
      // 1. Append de eventos
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCreated',
        payload: { title: 'Tarefa original' },
      });
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskUpdated',
        payload: { title: 'Tarefa atualizada' },
      });
      await eventStore.append({
        aggregateId: 'task-1',
        aggregateType: 'Task',
        eventType: 'TaskCompleted',
        payload: { completedAt: '2026-10-12T00:00:00Z' },
      });

      // 2. Replay: reconstrói o estado aplicando os eventos em ordem
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

      // 3. Estado final reconstruído
      expect(state).toEqual({
        title: 'Tarefa atualizada',
        completed: true,
      });
    });
  });
});