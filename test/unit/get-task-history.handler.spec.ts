import { NotFoundException } from '@nestjs/common';
import { GetTaskHistoryHandler } from '../../src/modules/tasks/queries/get-task-history.handler';
import { GetTaskHistoryQuery } from '../../src/modules/tasks/queries/get-task-history.query';
import { EventStoreService } from '../../src/events/event-store.service';
import { ProjectsService } from '../../src/modules/projects/projects.service';

describe('GetTaskHistoryHandler', () => {
  let handler: GetTaskHistoryHandler;
  let projects: { assertOwner: jest.Mock };
  let eventStore: { loadEvents: jest.Mock };

  const target = { userId: 'u-dono', projectId: 'p1', taskId: 't1' };
  const t0 = new Date('2026-10-18T10:00:00.000Z');

  const row = (version: number, eventType: string, payload: Record<string, unknown>) => ({
    id: `e${version}`,
    aggregateId: 't1',
    aggregateType: 'Task',
    eventType,
    payload,
    version,
    createdAt: new Date(t0.getTime() + version * 60_000), // um evento por minuto
  });

  const stream = [
    row(1, 'TaskCreated', { taskId: 't1', projectId: 'p1', title: 'Corrigir bug', priority: 'HIGH' }),
    row(2, 'TaskAssigned', { taskId: 't1', assigneeId: 'u1' }),
    row(3, 'TaskStatusChanged', { taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' }),
    row(4, 'TaskCompleted', { taskId: 't1', completedAt: '2026-10-18T10:04:00.000Z' }),
  ];

  beforeEach(() => {
    projects = { assertOwner: jest.fn().mockResolvedValue(undefined) };
    eventStore = { loadEvents: jest.fn().mockResolvedValue(stream) };
    handler = new GetTaskHistoryHandler(
      projects as unknown as ProjectsService,
      eventStore as unknown as EventStoreService,
    );
  });

  it('deve devolver a linha do tempo completa, em ordem, com versão e data de cada evento', async () => {
    const result = await handler.execute(new GetTaskHistoryQuery(target));

    expect(result.history.map((h) => [h.version, h.type])).toEqual([
      [1, 'TaskCreated'],
      [2, 'TaskAssigned'],
      [3, 'TaskStatusChanged'],
      [4, 'TaskCompleted'],
    ]);
    expect(result.history[2].data).toEqual({ taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' });
    expect(result.history[0].occurredAt).toEqual(new Date('2026-10-18T10:01:00.000Z'));
  });

  it('deve RECONSTRUIR o estado atual a partir dos próprios eventos (não do Read Model)', async () => {
    const result = await handler.execute(new GetTaskHistoryQuery(target));

    expect(result.current).toEqual({
      title: 'Corrigir bug',
      status: 'DONE',
      priority: 'HIGH',
      assigneeId: 'u1',
      dueDate: undefined,
      completedAt: '2026-10-18T10:04:00.000Z',
      version: 4,
    });
  });

  it('deve verificar a posse do projeto ANTES de ler o Event Store', async () => {
    projects.assertOwner.mockRejectedValue(new NotFoundException('Projeto não encontrado'));

    await expect(handler.execute(new GetTaskHistoryQuery(target))).rejects.toThrow(NotFoundException);
    expect(eventStore.loadEvents).not.toHaveBeenCalled();
  });

  it('deve responder 404 quando a tarefa não existe', async () => {
    eventStore.loadEvents.mockResolvedValue([]);

    await expect(handler.execute(new GetTaskHistoryQuery(target))).rejects.toThrow('Tarefa não encontrada');
  });

  it('deve responder o MESMO 404 para tarefa de outro projeto (não vaza o histórico alheio)', async () => {
    await expect(
      handler.execute(new GetTaskHistoryQuery({ ...target, projectId: 'p-outro' })),
    ).rejects.toThrow('Tarefa não encontrada');
  });
});
