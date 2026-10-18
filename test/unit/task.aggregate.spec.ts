import { TaskAggregate, TaskInvariantError } from '../../src/modules/tasks/domain/task.aggregate';
import type { TaskDomainEvent } from '../../src/modules/tasks/events/task.events';

describe('TaskAggregate', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');

  const created: TaskDomainEvent = {
    type: 'TaskCreated',
    data: { taskId: 't1', projectId: 'p1', title: 'Corrigir bug', priority: 'HIGH', dueDate: '2026-12-31T00:00:00.000Z' },
  };

  // ============================================================
  // Reidratação (replay)
  // ============================================================
  describe('fromHistory', () => {
    it('deve reconstruir o estado inicial a partir do TaskCreated', () => {
      const task = TaskAggregate.fromHistory([created]);

      expect(task.id).toBe('t1');
      expect(task.projectId).toBe('p1');
      expect(task.title).toBe('Corrigir bug');
      expect(task.priority).toBe('HIGH');
      expect(task.status).toBe('PENDING');
      expect(task.assigneeId).toBeUndefined();
      expect(task.dueDate).toBe('2026-12-31T00:00:00.000Z');
      expect(task.version).toBe(1);
    });

    it('deve aplicar todos os eventos em ordem e chegar ao estado atual', () => {
      const task = TaskAggregate.fromHistory([
        created,
        { type: 'TaskAssigned', data: { taskId: 't1', assigneeId: 'u1' } },
        { type: 'TaskStatusChanged', data: { taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' } },
        { type: 'TaskAssigned', data: { taskId: 't1', assigneeId: 'u2' } },
        { type: 'TaskCompleted', data: { taskId: 't1', completedAt: now.toISOString() } },
      ]);

      expect(task.assigneeId).toBe('u2'); // o último TaskAssigned vence
      expect(task.status).toBe('DONE');
      expect(task.completedAt).toBe(now.toISOString());
      expect(task.version).toBe(5);
    });

    it('não deve ter eventos pendentes logo após reidratar (o histórico já está persistido)', () => {
      const task = TaskAggregate.fromHistory([created]);

      expect(task.pullPendingEvents()).toEqual([]);
    });

    it('deve rejeitar histórico vazio (tarefa inexistente)', () => {
      expect(() => TaskAggregate.fromHistory([])).toThrow(TaskInvariantError);
    });

    it('deve rejeitar histórico que não começa com TaskCreated', () => {
      expect(() =>
        TaskAggregate.fromHistory([{ type: 'TaskAssigned', data: { taskId: 't1', assigneeId: 'u1' } }]),
      ).toThrow('primeiro evento deve ser TaskCreated');
    });
  });

  // ============================================================
  // assign
  // ============================================================
  describe('assign', () => {
    it('deve levantar TaskAssigned e atualizar o estado em memória', () => {
      const task = TaskAggregate.fromHistory([created]);

      task.assign('u1');

      expect(task.assigneeId).toBe('u1');
      expect(task.pullPendingEvents()).toEqual([
        { type: 'TaskAssigned', data: { taskId: 't1', assigneeId: 'u1' } },
      ]);
    });

    it('deve ser idempotente: atribuir ao mesmo responsável NÃO gera evento', () => {
      const task = TaskAggregate.fromHistory([created, { type: 'TaskAssigned', data: { taskId: 't1', assigneeId: 'u1' } }]);

      task.assign('u1');

      expect(task.pullPendingEvents()).toEqual([]);
    });
  });

  // ============================================================
  // changeStatus
  // ============================================================
  describe('changeStatus', () => {
    it('deve levantar TaskStatusChanged registrando de onde e para onde', () => {
      const task = TaskAggregate.fromHistory([created]);

      task.changeStatus('IN_PROGRESS');

      expect(task.status).toBe('IN_PROGRESS');
      expect(task.pullPendingEvents()).toEqual([
        { type: 'TaskStatusChanged', data: { taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' } },
      ]);
    });

    it('deve permitir voltar de IN_PROGRESS para PENDING', () => {
      const task = TaskAggregate.fromHistory([
        created,
        { type: 'TaskStatusChanged', data: { taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' } },
      ]);

      task.changeStatus('PENDING');

      expect(task.status).toBe('PENDING');
    });

    it('deve ser idempotente: mesmo status NÃO gera evento', () => {
      const task = TaskAggregate.fromHistory([created]);

      task.changeStatus('PENDING');

      expect(task.pullPendingEvents()).toEqual([]);
    });
  });

  // ============================================================
  // complete
  // ============================================================
  describe('complete', () => {
    it('deve levantar TaskCompleted com a data informada e ir para DONE', () => {
      const task = TaskAggregate.fromHistory([created]);

      task.complete(now);

      expect(task.status).toBe('DONE');
      expect(task.pullPendingEvents()).toEqual([
        { type: 'TaskCompleted', data: { taskId: 't1', completedAt: '2026-10-18T12:00:00.000Z' } },
      ]);
    });
  });

  // ============================================================
  // Invariantes: DONE é terminal
  // ============================================================
  describe('invariantes (tarefa concluída é imutável)', () => {
    const done = () =>
      TaskAggregate.fromHistory([
        created,
        { type: 'TaskCompleted', data: { taskId: 't1', completedAt: now.toISOString() } },
      ]);

    it.each([
      ['concluir de novo', (t: TaskAggregate) => t.complete(now)],
      ['reatribuir', (t: TaskAggregate) => t.assign('u9')],
      ['mudar o status', (t: TaskAggregate) => t.changeStatus('IN_PROGRESS')],
    ])('NÃO deve permitir %s', (_acao, comando) => {
      const task = done();

      expect(() => comando(task)).toThrow(TaskInvariantError);
      expect(task.pullPendingEvents()).toEqual([]); // regra violada = nenhum evento
    });
  });

  // ============================================================
  // Versão e eventos pendentes
  // ============================================================
  describe('versão e fila de eventos', () => {
    it('version reflete só o PERSISTIDO: comandos não a alteram (é o expectedVersion do save)', () => {
      const task = TaskAggregate.fromHistory([created]);

      task.assign('u1');
      task.changeStatus('IN_PROGRESS');

      expect(task.version).toBe(1);
      expect(task.pullPendingEvents()).toHaveLength(2);
    });

    it('pullPendingEvents deve esvaziar a fila (não reenviar os mesmos eventos)', () => {
      const task = TaskAggregate.fromHistory([created]);
      task.assign('u1');

      task.pullPendingEvents();

      expect(task.pullPendingEvents()).toEqual([]);
    });
  });
});
