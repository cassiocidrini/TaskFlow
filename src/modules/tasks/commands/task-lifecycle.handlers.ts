import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { TaskCommandRunner, type TaskSnapshot } from './task-command.runner';
import { AssignTaskCommand, ChangeTaskStatusCommand, CompleteTaskCommand } from './task-lifecycle.commands';

/*
 * Handlers do ciclo de vida: cada um declara SÓ a regra de negócio que muda (uma linha).
 *
 * Autorização, carregamento do agregado, tradução de erros, persistência com concorrência otimista e
 * publicação ficam no {@link TaskCommandRunner} (Template Method funcional) — escritos e testados UMA vez.
 * É o resultado que justifica o runner: adicionar um quarto comando custa ~5 linhas, e não há como
 * "esquecer" a autorização num handler novo.
 */

/** `assign` é idempotente no agregado: atribuir ao responsável atual não gera evento nem toca no banco. */
@CommandHandler(AssignTaskCommand)
export class AssignTaskHandler implements ICommandHandler<AssignTaskCommand, TaskSnapshot> {
  constructor(private readonly runner: TaskCommandRunner) {}

  execute({ target, assigneeId }: AssignTaskCommand): Promise<TaskSnapshot> {
    return this.runner.run(target, (task) => task.assign(assigneeId));
  }
}

/** O evento registra a origem E o destino (`from` → `to`): o histórico conta a mudança, não só o resultado. */
@CommandHandler(ChangeTaskStatusCommand)
export class ChangeTaskStatusHandler implements ICommandHandler<ChangeTaskStatusCommand, TaskSnapshot> {
  constructor(private readonly runner: TaskCommandRunner) {}

  execute({ target, status }: ChangeTaskStatusCommand): Promise<TaskSnapshot> {
    return this.runner.run(target, (task) => task.changeStatus(status));
  }
}

/**
 * O relógio é lido AQUI, na borda (`new Date()`), e entregue pronto ao agregado.
 * Assim o domínio continua determinístico: os testes do agregado controlam o tempo sem `jest.useFakeTimers()`.
 */
@CommandHandler(CompleteTaskCommand)
export class CompleteTaskHandler implements ICommandHandler<CompleteTaskCommand, TaskSnapshot> {
  constructor(private readonly runner: TaskCommandRunner) {}

  execute({ target }: CompleteTaskCommand): Promise<TaskSnapshot> {
    return this.runner.run(target, (task) => task.complete(new Date()));
  }
}
