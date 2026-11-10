import { z } from 'zod';

/*
 * O contrato de `taskflow.task-events.v1` como o CONSUMER de notificações o lê (Módulo 13.4).
 *
 * Cópia própria, e não um import de `tasks/events/task.integration-events.ts`: um serviço consumidor de verdade não
 * importa o código de quem publica (seria acoplamento de deploy: mudar o produtor quebraria o build do consumer). O
 * que liga os dois é o contrato publicado; um schema registry (limitação do Módulo 13) validaria isso no broker.
 *
 * **Leitor tolerante** (*tolerant reader*): só valida o que este consumer USA. Campo novo no evento é ignorado (o
 * `z.object` descarta o que não conhece); tipo de evento que não interessa ou versão de contrato maior que a
 * suportada é IGNORADO com aviso, em vez de travar a partição.
 */

/** Versão do contrato (`eventVersion`) que este consumer sabe ler, por tipo. */
export const SUPPORTED_EVENT_VERSION = 1;

const envelope = {
  eventId: z.uuid(),
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  aggregateId: z.uuid(),
  aggregateVersion: z.number().int().positive(),
  projectId: z.uuid(),
  actorId: z.uuid(),
  correlationId: z.string().optional(),
};

const taskEventSchema = z.discriminatedUnion('eventType', [
  z.object({
    ...envelope,
    eventType: z.literal('TaskCreated'),
    data: z.object({
      title: z.string().min(1),
      assigneeId: z.uuid().optional(),
    }),
  }),
  z.object({
    ...envelope,
    eventType: z.literal('TaskAssigned'),
    data: z.object({ assigneeId: z.uuid() }),
  }),
  z.object({
    ...envelope,
    eventType: z.literal('TaskCompleted'),
    data: z.object({ completedAt: z.iso.datetime() }),
  }),
]);

/** Os eventos que geram (ou preparam) notificação. */
export type TaskEvent = z.infer<typeof taskEventSchema>;

const HANDLED_TYPES = new Set<string>([
  'TaskCreated',
  'TaskAssigned',
  'TaskCompleted',
]);

/** Mensagem que nunca vai ser processável (JSON inválido, campo obrigatório ausente): a 13.5 a manda para o DLT. */
export class InvalidMessageError extends Error {}

export type ParsedMessage =
  { kind: 'event'; event: TaskEvent } | { kind: 'ignored'; reason: string };

/**
 * Converte o `value` da mensagem num evento tipado.
 *
 * @returns `ignored` para tipo que este consumer não trata (ex.: `TaskStatusChanged`) ou versão de contrato nova.
 * @throws InvalidMessageError para mensagem malformada de um tipo que ele TRATA (não dá para ignorar em silêncio:
 *         seria perder uma notificação sem ninguém saber).
 */
export function parseTaskEvent(value: string | null): ParsedMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(value ?? '');
  } catch {
    throw new InvalidMessageError('corpo da mensagem não é JSON');
  }
  const header = z
    .object({
      eventType: z.string(),
      eventVersion: z.number().int().positive(),
    })
    .safeParse(raw);
  if (!header.success) {
    throw new InvalidMessageError('mensagem sem eventType/eventVersion');
  }
  if (!HANDLED_TYPES.has(header.data.eventType)) {
    return {
      kind: 'ignored',
      reason: `tipo ${header.data.eventType} não gera notificação`,
    };
  }
  if (header.data.eventVersion > SUPPORTED_EVENT_VERSION) {
    return {
      kind: 'ignored',
      reason: `${header.data.eventType} v${header.data.eventVersion} é mais novo que a v${SUPPORTED_EVENT_VERSION} suportada`,
    };
  }

  const parsed = taskEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InvalidMessageError(
      `${header.data.eventType} inválido: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { kind: 'event', event: parsed.data };
}
