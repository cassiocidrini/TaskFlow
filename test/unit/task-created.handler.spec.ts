import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { TaskCreatedHandler } from '../../src/modules/tasks/events/task-created.handler';
import { TaskCreatedEvent } from '../../src/modules/tasks/events/task.events';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('TaskCreatedHandler (projeção para tasks_read)', () => {
  let handler: TaskCreatedHandler;
  let prisma: { taskRead: { createMany: jest.Mock } };
  let loggerError: jest.SpyInstance;

  const event = new TaskCreatedEvent({
    taskId: 'task-1',
    projectId: 'p1',
    title: 'Minha tarefa',
    priority: 'HIGH',
    assigneeId: 'u1',
  });

  beforeEach(async () => {
    prisma = { taskRead: { createMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    // Silencia e espiona o logger (não polui a saída dos testes)
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

    const module: TestingModule = await Test.createTestingModule({
      providers: [TaskCreatedHandler, { provide: PrismaService, useValue: prisma }],
    }).compile();

    handler = module.get(TaskCreatedHandler);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('deve projetar o evento em tasks_read com status PENDING, prioridade e sem prazo', async () => {
    await handler.handle(event);

    expect(prisma.taskRead.createMany).toHaveBeenCalledWith({
      data: [
        {
          id: 'task-1',
          projectId: 'p1',
          title: 'Minha tarefa',
          assigneeId: 'u1',
          status: 'PENDING',
          priority: 'HIGH',
          dueDate: null,
        },
      ],
      skipDuplicates: true,
    });
  });

  it('deve converter o dueDate ISO do evento em Date para a coluna due_date', async () => {
    const comPrazo = new TaskCreatedEvent({ ...event, dueDate: '2026-12-31T23:59:59.000Z' });

    await handler.handle(comPrazo);

    const [args] = prisma.taskRead.createMany.mock.calls[0];
    expect(args.data[0].dueDate).toEqual(new Date('2026-12-31T23:59:59.000Z'));
  });

  it('deve ser IDEMPOTENTE: usar skipDuplicates (INSERT ... ON CONFLICT DO NOTHING)', async () => {
    await handler.handle(event);

    const [args] = prisma.taskRead.createMany.mock.calls[0];
    expect(args.skipDuplicates).toBe(true);
  });

  it('deve aceitar a MESMA entrega duas vezes sem lançar erro (at-least-once delivery)', async () => {
    // 2ª entrega: o banco ignora o duplicado e reporta 0 linhas inseridas
    prisma.taskRead.createMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    await expect(handler.handle(event)).resolves.toBeUndefined();
    await expect(handler.handle(event)).resolves.toBeUndefined();
  });

  it('deve LOGAR e relançar quando a projeção falhar (falha visível, não silenciosa)', async () => {
    prisma.taskRead.createMany.mockRejectedValue(new Error('DB fora do ar'));

    await expect(handler.handle(event)).rejects.toThrow('DB fora do ar');

    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('taskId=task-1'),
      expect.any(String),
    );
  });
});
