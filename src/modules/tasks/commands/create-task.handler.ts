import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import { CreateTaskCommand } from './create-task.command';
import { EventStoreService } from '../../../events/event-store.service';
import { TaskCreatedEvent, type TaskCreatedData } from '../events/task.events';
import { KeywordPriorityStrategy } from '../strategies/task-priority.strategy';
import { ProjectsService } from '../../projects/projects.service';

/**
 * Cria uma tarefa — o nascimento de um agregado event-sourced.
 *
 * Roteiro (a ORDEM é regra de negócio, coberta por testes):
 * 1. **`assertOwner`** — autorização ANTES de qualquer efeito. O Event Store é append-only: um evento gravado
 *    indevidamente nunca mais sai (OWASP A01).
 * 2. **`append(…, 0)`** — grava `TaskCreated` esperando a versão 0 (agregado novo). O `UNIQUE (aggregate_id, version)`
 *    garante que dois `TaskCreated` para o mesmo ID nunca coexistam.
 * 3. **`publish`** — só DEPOIS de gravar: nunca se publica o que não foi persistido.
 *
 * É anterior ao {@link TaskCommandRunner} porque não há agregado para carregar — a tarefa ainda não existe.
 */
@CommandHandler(CreateTaskCommand)
export class CreateTaskHandler implements ICommandHandler<CreateTaskCommand> {
  /**
   * Strategy Pattern: o cálculo de prioridade é uma família de algoritmos atrás de uma interface.
   *
   * **Limitação conhecida:** instanciada com `new` aqui, e não injetada. Assim o padrão tem a FORMA, mas não o
   * benefício (trocar o algoritmo sem editar este handler). O caminho completo seria um provider
   * (`{ provide: TASK_PRIORITY_STRATEGY, useClass: … }`) — ver Módulo 12.
   */
  private priorityStrategy = new KeywordPriorityStrategy();

  constructor(
    private readonly eventStore: EventStoreService,
    private readonly eventBus: EventBus,
    private readonly projects: ProjectsService,
  ) {}

  /** @returns o ID da nova tarefa (também é o `aggregate_id` no Event Store). */
  async execute(command: CreateTaskCommand): Promise<string> {
    await this.projects.assertOwner(command.projectId, command.userId);

    const taskId = randomUUID();

    // UM único objeto alimenta o Event Store E o EventBus: o evento gravado e o publicado são idênticos
    // por construção. Antes, eram montados separadamente — e a prioridade se perdia no caminho.
    const data: TaskCreatedData = {
      taskId,
      projectId: command.projectId,
      title: command.title,
      priority: this.priorityStrategy.calculate(command.title, command.dueDate),
      assigneeId: command.assigneeId,
      dueDate: command.dueDate?.toISOString(),
    };

    await this.eventStore.append(
      { aggregateId: taskId, aggregateType: 'Task', eventType: 'TaskCreated', payload: { ...data } },
      0, // agregado NOVO: esperamos encontrá-lo sem nenhum evento (versão 0)
    );

    this.eventBus.publish(new TaskCreatedEvent(data));
    return taskId;
  }
}
