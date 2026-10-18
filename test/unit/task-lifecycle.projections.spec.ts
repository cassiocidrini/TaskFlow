/**
 * Projeções dos eventos de ciclo de vida (`UPDATE … SET`).
 *
 * Protege: cada evento atualiza a coluna certa, reaplicar o mesmo evento produz o mesmo UPDATE (idempotência
 * natural), linha ausente vira WARN e não queda (evento fora de ordem) e falha de banco é logada e relançada.
 */
import { Logger } from '@nestjs/common';
import {
  TaskAssignedProjection,
  TaskCompletedProjection,
  TaskStatusChangedProjection,
} from '../../src/modules/tasks/events/task-lifecycle.projections';
import {
  TaskAssignedEvent,
  TaskCompletedEvent,
  TaskStatusChangedEvent,
} from '../../src/modules/tasks/events/task.events';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('Projeções do ciclo de vida (tasks_read)', () => {
  let prisma: { taskRead: { updateMany: jest.Mock } };
  let loggerWarn: jest.SpyInstance;
  let loggerError: jest.SpyInstance;

  beforeEach(() => {
    prisma = { taskRead: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } };
    loggerWarn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    loggerError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const asPrisma = () => prisma as unknown as PrismaService;

  // ============================================================
  // Cada evento atualiza a coluna certa
  // ============================================================
  it('TaskAssigned deve atualizar assignee_id', async () => {
    await new TaskAssignedProjection(asPrisma()).handle(new TaskAssignedEvent({ taskId: 't1', assigneeId: 'u1' }));

    expect(prisma.taskRead.updateMany).toHaveBeenCalledWith({ where: { id: 't1' }, data: { assigneeId: 'u1' } });
  });

  it('TaskStatusChanged deve gravar o status DE DESTINO', async () => {
    await new TaskStatusChangedProjection(asPrisma()).handle(
      new TaskStatusChangedEvent({ taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' }),
    );

    expect(prisma.taskRead.updateMany).toHaveBeenCalledWith({ where: { id: 't1' }, data: { status: 'IN_PROGRESS' } });
  });

  it('TaskCompleted deve marcar DONE e converter completedAt (ISO) em Date', async () => {
    await new TaskCompletedProjection(asPrisma()).handle(
      new TaskCompletedEvent({ taskId: 't1', completedAt: '2026-10-18T12:00:00.000Z' }),
    );

    expect(prisma.taskRead.updateMany).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: { status: 'DONE', completedAt: new Date('2026-10-18T12:00:00.000Z') },
    });
  });

  // ============================================================
  // Robustez
  // ============================================================
  it('deve ser idempotente: reaplicar o mesmo evento produz o mesmo UPDATE, sem erro', async () => {
    const projection = new TaskStatusChangedProjection(asPrisma());
    const event = new TaskStatusChangedEvent({ taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' });

    await projection.handle(event);
    await projection.handle(event);

    expect(prisma.taskRead.updateMany.mock.calls[0]).toEqual(prisma.taskRead.updateMany.mock.calls[1]);
  });

  it('deve emitir WARN (e não quebrar) quando a linha ainda não existe — evento fora de ordem', async () => {
    prisma.taskRead.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      new TaskAssignedProjection(asPrisma()).handle(new TaskAssignedEvent({ taskId: 't-fantasma', assigneeId: 'u1' })),
    ).resolves.toBeUndefined();

    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('taskId=t-fantasma'));
  });

  it('deve LOGAR e relançar quando o banco falhar (falha visível)', async () => {
    prisma.taskRead.updateMany.mockRejectedValue(new Error('DB fora do ar'));

    await expect(
      new TaskCompletedProjection(asPrisma()).handle(
        new TaskCompletedEvent({ taskId: 't1', completedAt: '2026-10-18T12:00:00.000Z' }),
      ),
    ).rejects.toThrow('DB fora do ar');

    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('TaskCompleted'), expect.any(String));
  });
});
