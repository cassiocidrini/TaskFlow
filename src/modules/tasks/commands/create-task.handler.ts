import { CommandHandler, ICommandHandler, EventBus } from '@nestjs/cqrs';
import { randomUUID } from 'crypto';
import { CreateTaskCommand, type CreateTaskResult } from './create-task.command';
import { IdempotencyStore, type StoredResponse } from '../../../common/idempotency/idempotency.store';
import { ConcurrencyConflictError, EventStoreService } from '../../../events/event-store.service';
import { toTaskOutboxMessage } from '../events/task.integration-events';
import { TASK_EVENT_SCHEMA_VERSIONS, TaskCreatedEvent, type TaskCreatedData } from '../events/task.events';
import { KeywordPriorityStrategy } from '../strategies/task-priority.strategy';
import { ProjectsService } from '../../projects/projects.service';

/**
 * Cria uma tarefa — o nascimento de um agregado event-sourced.
 *
 * Roteiro (a ORDEM é regra de negócio, coberta por testes):
 * 1. **`assertOwner`** — autorização ANTES de qualquer efeito. O Event Store é append-only: um evento gravado
 *    indevidamente nunca mais sai (OWASP A01).
 * 2. **`append(…, 0)`** — grava `TaskCreated` esperando a versão 0 (agregado novo). O `UNIQUE (aggregate_id, version)`
 *    garante que dois `TaskCreated` para o mesmo ID nunca coexistam. Na mesma transação, o evento de integração
 *    vai para a outbox (Módulo 13.2): este handler grava fora do repositório, então liga o mapper ele mesmo.
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
    private readonly idempotency: IdempotencyStore,
  ) {}

  /**
   * @returns o ID da tarefa (também é o `aggregate_id` no Event Store) e se a resposta é a repetição de uma criação
   * anterior com a mesma `Idempotency-Key` (Módulo 14.5).
   */
  async execute(command: CreateTaskCommand): Promise<CreateTaskResult> {
    await this.projects.assertOwner(command.projectId, command.userId);

    // Mesma chave, já usada: devolve a resposta guardada (ou 422, se o pedido for outro), sem criar nada
    const request = command.idempotency ? { userId: command.userId, ...command.idempotency } : undefined;
    if (request) {
      const stored = await this.idempotency.find(request.userId, request.key);
      if (stored) return replayed(this.idempotency.replay(stored, request));
    }

    const taskId = randomUUID();

    // UM único objeto alimenta o Event Store E o EventBus: o evento gravado e o publicado são idênticos
    // por construção. Antes, eram montados separadamente — e a prioridade se perdia no caminho.
    const data: TaskCreatedData = {
      taskId,
      projectId: command.projectId,
      title: command.title,
      priority: this.priorityStrategy.calculate(command.title, command.due?.at),
      assigneeId: command.assigneeId,
      // O instante em UTC + o fuso: juntos, reconstroem a hora local do usuário (Módulo 14.4)
      ...(command.due ? { due: { at: command.due.at.toISOString(), timezone: command.due.timezone } } : {}),
    };

    try {
      await this.eventStore.append(
        {
          aggregateId: taskId,
          aggregateType: 'Task',
          eventType: 'TaskCreated',
          payload: { ...data },
          schemaVersion: TASK_EVENT_SCHEMA_VERSIONS.TaskCreated,
        },
        0, // agregado NOVO: esperamos encontrá-lo sem nenhum evento (versão 0)
        { actorId: command.userId }, // userId do JWT (o controller nunca o lê do body)
        {
          toOutbox: (recorded) => toTaskOutboxMessage({ type: 'TaskCreated', data }, recorded, data.projectId),
          // A chave vai NA MESMA transação do evento: ou a tarefa existe e a chave está registrada, ou nenhuma
          alsoWrite: request ? this.idempotency.writes(request, { status: 201, body: { taskId } }) : undefined,
        },
      );
    } catch (error) {
      // Outra requisição com a MESMA chave gravou primeiro: a chave primária desfez esta transação inteira (a tarefa
      // daqui não existe). Busca de novo e devolve a resposta da vencedora. Consultar a tabela, e não interpretar o
      // nome da constraint no erro do Prisma, é o que não quebra numa atualização do Prisma; um conflito de versão de
      // verdade num agregado NOVO exigiria dois UUIDs aleatórios iguais.
      if (request && error instanceof ConcurrencyConflictError) {
        const winner = await this.idempotency.find(request.userId, request.key);
        if (winner) return replayed(this.idempotency.replay(winner, request));
      }
      throw error;
    }

    if (request) this.idempotency.count('created');
    this.eventBus.publish(new TaskCreatedEvent(data));
    return { taskId, replayed: false };
  }
}

/** A resposta guardada é sempre a do `POST /tasks` (`{ taskId }`): a chave é deste endpoint. */
function replayed(stored: StoredResponse): CreateTaskResult {
  return { taskId: (stored.body as { taskId: string }).taskId, replayed: true };
}
