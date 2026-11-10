/*
 * Eventos de INTEGRAÇÃO da tarefa: o contrato PÚBLICO publicado em `taskflow.task-events.v1` (Módulo 13.2).
 *
 * Evento de domínio × evento de integração:
 * - o de DOMÍNIO (`task.events.ts`) é interno: o agregado o reaplica no replay e o formato pode evoluir com
 *   upcasters, porque só este serviço o lê;
 * - o de INTEGRAÇÃO é o que outros serviços consomem. Mudar um campo quebra quem está do outro lado do tópico,
 *   então ele é mapeado CAMPO A CAMPO a partir do de domínio (sem `...spread`): um campo novo no domínio não
 *   vaza sozinho para o contrato público.
 *
 * O envelope reúne o que todo consumer precisa sem consultar o nosso banco: identidade e versão do contrato
 * (`eventId`, `eventType`, `eventVersion`), ordem (`aggregateId` + `aggregateVersion`), contexto (`projectId`,
 * que o `TaskCompleted` de domínio nem carrega) e rastreabilidade (`actorId`, `correlationId`). Os nomes seguem os
 * conceitos do CloudEvents (id, type, time, subject), sem adotar a especificação inteira.
 */
import type { OutboxMessage, RecordedEvent } from '../../../events/outbox';
import type {
  OpenTaskStatus,
  TaskDomainEvent,
  TaskPriority,
} from './task.events';

/** Tópico do contrato. O `.v1` é do TÓPICO: uma quebra incompatível do envelope vai para um `.v2` novo. */
export const TASK_EVENTS_TOPIC = 'taskflow.task-events.v1';

/**
 * `actorId` de um evento LEGADO, gravado antes do envelope de metadados existir (Módulo 05), quando republicado pelo
 * replay (Módulo 13.6b). O contrato exige um autor; para esses eventos ele é desconhecido, e o UUID nulo diz isso de
 * forma explícita e válida (passa no `z.uuid()` dos consumers), em vez de inventar um autor ou omitir o campo.
 */
export const UNKNOWN_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Versão do formato do `data` de cada tipo, NO CONTRATO PÚBLICO. Independente do `schemaVersion` do domínio:
 * um upcaster interno não muda o que o consumer recebe, e vice-versa. Mudança compatível (campo opcional novo)
 * mantém a versão; incompatível incrementa, e o consumer decide pelo `eventVersion` como ler.
 */
export const TASK_INTEGRATION_EVENT_VERSIONS: Readonly<
  Record<TaskDomainEvent['type'], number>
> = {
  TaskCreated: 1,
  TaskAssigned: 1,
  TaskStatusChanged: 1,
  TaskCompleted: 1,
};

export interface TaskCreatedIntegrationData {
  title: string;
  priority: TaskPriority;
  assigneeId?: string;
  /** ISO 8601 */
  dueDate?: string;
}

export interface TaskAssignedIntegrationData {
  assigneeId: string;
}

export interface TaskStatusChangedIntegrationData {
  from: OpenTaskStatus;
  to: OpenTaskStatus;
}

export interface TaskCompletedIntegrationData {
  /** ISO 8601 — o instante de negócio; `occurredAt` do envelope é o instante da gravação */
  completedAt: string;
}

/** Envelope comum. `taskId` não se repete no `data`: é o `aggregateId`. */
interface TaskIntegrationEnvelope<
  TType extends TaskDomainEvent['type'],
  TData,
> {
  eventId: string;
  eventType: TType;
  eventVersion: number;
  /** ISO 8601 — quando o evento foi gravado no Event Store */
  occurredAt: string;
  aggregateId: string;
  /** Versão da tarefa depois deste evento: o consumer detecta evento repetido ou fora de ordem */
  aggregateVersion: number;
  projectId: string;
  actorId: string;
  /** Ausente quando o evento nasceu fora de uma requisição HTTP */
  correlationId?: string;
  data: TData;
}

/** União discriminada de tudo o que pode sair no tópico; `eventType` estreita o `data` no consumer. */
export type TaskIntegrationEvent =
  | TaskIntegrationEnvelope<'TaskCreated', TaskCreatedIntegrationData>
  | TaskIntegrationEnvelope<'TaskAssigned', TaskAssignedIntegrationData>
  | TaskIntegrationEnvelope<
      'TaskStatusChanged',
      TaskStatusChangedIntegrationData
    >
  | TaskIntegrationEnvelope<'TaskCompleted', TaskCompletedIntegrationData>;

/**
 * Monta o evento de integração. Função PURA (sem banco, sem relógio): o instante, a versão e o envelope chegam
 * prontos do Event Store em `recorded`, e o `projectId` vem do agregado.
 */
export function toTaskIntegrationEvent(
  event: TaskDomainEvent,
  recorded: Omit<RecordedEvent, 'event'>,
  projectId: string,
): TaskIntegrationEvent {
  const envelope = {
    eventId: recorded.metadata.eventId,
    eventVersion: TASK_INTEGRATION_EVENT_VERSIONS[event.type],
    occurredAt: recorded.recordedAt.toISOString(),
    aggregateId: event.data.taskId,
    aggregateVersion: recorded.aggregateVersion,
    projectId,
    actorId: recorded.metadata.actorId,
    ...(recorded.metadata.correlationId
      ? { correlationId: recorded.metadata.correlationId }
      : {}),
  };

  // Switch exaustivo: um evento de domínio novo sem mapeamento deixa de compilar (o `never` do default)
  switch (event.type) {
    case 'TaskCreated': {
      const { title, priority, assigneeId, dueDate } = event.data;
      return {
        ...envelope,
        eventType: event.type,
        data: {
          title,
          priority,
          ...(assigneeId ? { assigneeId } : {}),
          ...(dueDate ? { dueDate } : {}),
        },
      };
    }
    case 'TaskAssigned':
      return {
        ...envelope,
        eventType: event.type,
        data: { assigneeId: event.data.assigneeId },
      };
    case 'TaskStatusChanged':
      return {
        ...envelope,
        eventType: event.type,
        data: { from: event.data.from, to: event.data.to },
      };
    case 'TaskCompleted':
      return {
        ...envelope,
        eventType: event.type,
        data: { completedAt: event.data.completedAt },
      };
    default: {
      const unreachable: never = event;
      throw new Error(
        `Evento sem contrato de integração: ${JSON.stringify(unreachable)}`,
      );
    }
  }
}

/**
 * Embrulha o evento de integração na mensagem da outbox: tópico do contrato e chave = `taskId`. A chave manda
 * todos os eventos da MESMA tarefa para a mesma partição, que é onde o Kafka garante ordem.
 */
export function toTaskOutboxMessage(
  event: TaskDomainEvent,
  recorded: Omit<RecordedEvent, 'event'>,
  projectId: string,
): OutboxMessage {
  const integrationEvent = toTaskIntegrationEvent(event, recorded, projectId);
  return {
    topic: TASK_EVENTS_TOPIC,
    key: integrationEvent.aggregateId,
    eventType: integrationEvent.eventType,
    payload: { ...integrationEvent },
  };
}
