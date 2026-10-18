import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { TaskCommandRunner, type TaskSnapshot } from './task-command.runner';
import { AssignTaskCommand, ChangeTaskStatusCommand, CompleteTaskCommand } from './task-lifecycle.commands';

// Cada handler declara SÓ a regra de negócio que muda. Autorização, carga, tradução de erros,
// persistência com concorrência otimista e publicação ficam no TaskCommandRunner.

@CommandHandler(AssignTaskCommand)
export class AssignTaskHandler implements ICommandHandler<AssignTaskCommand, TaskSnapshot> {
  constructor(private readonly runner: TaskCommandRunner) {}

  execute({ target, assigneeId }: AssignTaskCommand): Promise<TaskSnapshot> {
    return this.runner.run(target, (task) => task.assign(assigneeId));
  }
}

@CommandHandler(ChangeTaskStatusCommand)
export class ChangeTaskStatusHandler implements ICommandHandler<ChangeTaskStatusCommand, TaskSnapshot> {
  constructor(private readonly runner: TaskCommandRunner) {}

  execute({ target, status }: ChangeTaskStatusCommand): Promise<TaskSnapshot> {
    return this.runner.run(target, (task) => task.changeStatus(status));
  }
}

@CommandHandler(CompleteTaskCommand)
export class CompleteTaskHandler implements ICommandHandler<CompleteTaskCommand, TaskSnapshot> {
  constructor(private readonly runner: TaskCommandRunner) {}

  execute({ target }: CompleteTaskCommand): Promise<TaskSnapshot> {
    // O relógio é lido AQUI, na borda — o agregado recebe a data pronta e continua puro e testável
    return this.runner.run(target, (task) => task.complete(new Date()));
  }
}
