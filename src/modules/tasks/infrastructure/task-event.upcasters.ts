import {
  TASK_EVENT_SCHEMA_VERSIONS,
  type TaskCreatedData,
  type TaskDomainEvent,
} from '../events/task.events';

/** `TaskCreated` como foi gravado até o Módulo 14.4 (schemaVersion 1): o prazo era só um instante. */
interface TaskCreatedDataV1 {
  taskId: string;
  projectId: string;
  title: string;
  priority: TaskCreatedData['priority'];
  assigneeId?: string;
  dueDate?: string;
}

/**
 * *Upcasting* (Módulo 14.4): converte o payload de um evento gravado numa versão ANTIGA para o formato atual, na
 * LEITURA. O Event Store é append-only e o histórico é a fonte da verdade, então um evento gravado nunca é reescrito;
 * quem muda é o código que o lê. O agregado, as projeções e o replay só conhecem o formato atual.
 *
 * Cadeia de versões: cada função leva da versão N para a N+1, e eventos muito antigos passam por todas. Hoje há uma:
 * `TaskCreated` v1 `{ dueDate }` → v2 `{ due: { at, timezone: null } }`. O fuso fica `null` porque a v1 não o
 * registrou: inventar um seria gravar como fato o que ninguém disse (a mesma regra do `actorId` de evento legado).
 *
 * Evento legado SEM envelope (`metadata = {}`, anterior ao Módulo 0.2) não tem `schemaVersion`: conta como v1, que era
 * a única versão antes de existir o campo.
 */
export function upcastPayload(
  type: TaskDomainEvent['type'],
  payload: Record<string, unknown>,
  storedVersion: number | undefined,
): Record<string, unknown> {
  const current = TASK_EVENT_SCHEMA_VERSIONS[type];
  const version = storedVersion ?? 1;
  if (version > current) {
    // Evento gravado por um código mais NOVO que este (deploy revertido?): ler adivinhando seria pior que falhar
    throw new Error(
      `${type} v${version} é mais novo que a v${current} que este código sabe ler`,
    );
  }
  if (type === 'TaskCreated' && version < 2) {
    return taskCreatedV1ToV2(payload as unknown as TaskCreatedDataV1);
  }
  return payload;
}

/** Campo a campo, sem `...spread`: um campo inesperado no payload antigo não atravessa para o formato novo. */
function taskCreatedV1ToV2(v1: TaskCreatedDataV1): Record<string, unknown> {
  const v2: TaskCreatedData = {
    taskId: v1.taskId,
    projectId: v1.projectId,
    title: v1.title,
    priority: v1.priority,
    ...(v1.assigneeId ? { assigneeId: v1.assigneeId } : {}),
    ...(v1.dueDate ? { due: { at: v1.dueDate, timezone: null } } : {}),
  };
  return v2 as unknown as Record<string, unknown>;
}
