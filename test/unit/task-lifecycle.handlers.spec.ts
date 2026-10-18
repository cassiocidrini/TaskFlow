import {
  AssignTaskHandler,
  ChangeTaskStatusHandler,
  CompleteTaskHandler,
} from '../../src/modules/tasks/commands/task-lifecycle.handlers';
import {
  AssignTaskCommand,
  ChangeTaskStatusCommand,
  CompleteTaskCommand,
} from '../../src/modules/tasks/commands/task-lifecycle.commands';
import { TaskCommandRunner } from '../../src/modules/tasks/commands/task-command.runner';
import { TaskAggregate } from '../../src/modules/tasks/domain/task.aggregate';

describe('Handlers de ciclo de vida da tarefa', () => {
  const target = { userId: 'u-dono', projectId: 'p1', taskId: 't1' };

  let task: TaskAggregate;
  let runner: { run: jest.Mock };

  beforeEach(() => {
    task = TaskAggregate.fromHistory([
      { type: 'TaskCreated', data: { taskId: 't1', projectId: 'p1', title: 'Tarefa', priority: 'MEDIUM' } },
    ]);
    // Runner falso: aplica a mutação num agregado REAL — prova que o handler chama o método certo do domínio
    runner = {
      run: jest.fn().mockImplementation(async (_target, mutate: (t: TaskAggregate) => void) => {
        mutate(task);
        return { taskId: task.id, status: task.status };
      }),
    };
  });

  const asRunner = () => runner as unknown as TaskCommandRunner;

  it('AssignTaskHandler deve repassar o target e atribuir o responsável', async () => {
    await new AssignTaskHandler(asRunner()).execute(new AssignTaskCommand(target, 'u1'));

    expect(runner.run).toHaveBeenCalledWith(target, expect.any(Function));
    expect(task.assigneeId).toBe('u1');
  });

  it('ChangeTaskStatusHandler deve mudar o status para o valor do command', async () => {
    await new ChangeTaskStatusHandler(asRunner()).execute(new ChangeTaskStatusCommand(target, 'IN_PROGRESS'));

    expect(runner.run).toHaveBeenCalledWith(target, expect.any(Function));
    expect(task.status).toBe('IN_PROGRESS');
  });

  it('CompleteTaskHandler deve concluir a tarefa com a data atual', async () => {
    const antes = Date.now();

    await new CompleteTaskHandler(asRunner()).execute(new CompleteTaskCommand(target));

    expect(task.status).toBe('DONE');
    expect(new Date(task.completedAt!).getTime()).toBeGreaterThanOrEqual(antes);
  });

  it('deve devolver o snapshot produzido pelo runner', async () => {
    const result = await new CompleteTaskHandler(asRunner()).execute(new CompleteTaskCommand(target));

    expect(result).toEqual({ taskId: 't1', status: 'DONE' });
  });
});
