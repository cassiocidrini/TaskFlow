import { EventSourcedTaskRepository } from '../../src/modules/tasks/infrastructure/event-sourced-task.repository';
import { ConcurrencyConflictError, EventStoreService } from '../../src/events/event-store.service';
import { TaskAggregate } from '../../src/modules/tasks/domain/task.aggregate';

describe('EventSourcedTaskRepository', () => {
  let repository: EventSourcedTaskRepository;
  let eventStore: { loadEvents: jest.Mock; appendMany: jest.Mock };

  // Linhas no formato da tabela `events`
  const row = (version: number, eventType: string, payload: Record<string, unknown>) => ({
    id: `e${version}`,
    aggregateId: 't1',
    aggregateType: 'Task',
    eventType,
    payload,
    version,
    createdAt: new Date(),
  });

  const createdRow = row(1, 'TaskCreated', { taskId: 't1', projectId: 'p1', title: 'Tarefa', priority: 'MEDIUM' });

  beforeEach(() => {
    eventStore = {
      loadEvents: jest.fn(),
      appendMany: jest.fn().mockImplementation(async (events: unknown[], v: number) => v + events.length),
    };
    // Instância direta: a classe é simples e não precisa do container do Nest para ser testada
    repository = new EventSourcedTaskRepository(eventStore as unknown as EventStoreService);
  });

  // ============================================================
  // load
  // ============================================================
  describe('load', () => {
    it('deve retornar null quando a tarefa não tem eventos (não existe)', async () => {
      eventStore.loadEvents.mockResolvedValue([]);

      await expect(repository.load('t1')).resolves.toBeNull();
    });

    it('deve reidratar o agregado aplicando o histórico em ordem', async () => {
      eventStore.loadEvents.mockResolvedValue([
        createdRow,
        row(2, 'TaskAssigned', { taskId: 't1', assigneeId: 'u1' }),
        row(3, 'TaskStatusChanged', { taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' }),
      ]);

      const task = await repository.load('t1');

      expect(task).not.toBeNull();
      expect(task!.assigneeId).toBe('u1');
      expect(task!.status).toBe('IN_PROGRESS');
      expect(task!.version).toBe(3);
    });

    it('deve falhar ALTO diante de um tipo de evento desconhecido no stream', async () => {
      eventStore.loadEvents.mockResolvedValue([createdRow, row(2, 'TaskTeleported', {})]);

      await expect(repository.load('t1')).rejects.toThrow('Evento desconhecido');
    });
  });

  // ============================================================
  // save
  // ============================================================
  describe('save', () => {
    it('deve gravar os eventos pendentes com expectedVersion = versão carregada', async () => {
      const task = TaskAggregate.fromHistory([
        { type: 'TaskCreated', data: { taskId: 't1', projectId: 'p1', title: 'Tarefa', priority: 'MEDIUM' } },
      ]);
      task.assign('u1');
      task.changeStatus('IN_PROGRESS');

      const saved = await repository.save(task);

      expect(eventStore.appendMany).toHaveBeenCalledWith(
        [
          { aggregateId: 't1', aggregateType: 'Task', eventType: 'TaskAssigned', payload: { taskId: 't1', assigneeId: 'u1' } },
          {
            aggregateId: 't1',
            aggregateType: 'Task',
            eventType: 'TaskStatusChanged',
            payload: { taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' },
          },
        ],
        1, // o agregado foi lido na versão 1
      );
      expect(saved.map((e) => e.type)).toEqual(['TaskAssigned', 'TaskStatusChanged']);
    });

    it('NÃO deve tocar no banco quando não há eventos pendentes (comando idempotente)', async () => {
      const task = TaskAggregate.fromHistory([
        { type: 'TaskCreated', data: { taskId: 't1', projectId: 'p1', title: 'Tarefa', priority: 'MEDIUM' } },
      ]);
      task.changeStatus('PENDING'); // já está PENDING → nenhum evento

      await expect(repository.save(task)).resolves.toEqual([]);
      expect(eventStore.appendMany).not.toHaveBeenCalled();
    });

    it('deve propagar o ConcurrencyConflictError do Event Store (vira 409 na borda)', async () => {
      eventStore.appendMany.mockRejectedValue(new ConcurrencyConflictError());
      const task = TaskAggregate.fromHistory([
        { type: 'TaskCreated', data: { taskId: 't1', projectId: 'p1', title: 'Tarefa', priority: 'MEDIUM' } },
      ]);
      task.complete(new Date());

      await expect(repository.save(task)).rejects.toThrow(ConcurrencyConflictError);
    });
  });
});
