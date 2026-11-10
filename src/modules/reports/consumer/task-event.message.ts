import { z } from 'zod';
import { NonRetryableError } from '../../../common/messaging/consumer-errors';

/*
 * O contrato de `taskflow.task-events.v1` como o CONSUMER de relatórios o lê (Módulo 13.6a).
 *
 * Cópia própria, como a do consumer de notificações, e independente DELA: cada contexto valida só o que usa, e um não
 * importa o outro (seriam dois serviços). O `reports` precisa do `TaskStatusChanged`, que o `notifications` ignora, e
 * não precisa do título, que o `notifications` exige.
 *
 * Leitor tolerante: campo novo é descartado; tipo desconhecido ou versão de contrato maior que a suportada é
 * IGNORADO com aviso; mensagem malformada de um tipo tratado é `InvalidMessageError` (vai ao DLT, Módulo 13.5).
 */

/** Versão do contrato (`eventVersion`) que este consumer sabe ler. */
export const SUPPORTED_EVENT_VERSION = 1;

const envelope = {
  eventId: z.uuid(),
  eventVersion: z.number().int().positive(),
  occurredAt: z.iso.datetime(),
  aggregateId: z.uuid(),
  // A guarda de idempotência deste consumer: sem ela, não há como reconhecer uma duplicata
  aggregateVersion: z.number().int().positive(),
  projectId: z.uuid(),
};

const openStatus = z.enum(['PENDING', 'IN_PROGRESS']);

const taskEventSchema = z.discriminatedUnion('eventType', [
  z.object({
    ...envelope,
    eventType: z.literal('TaskCreated'),
    data: z.object({ assigneeId: z.uuid().optional() }),
  }),
  z.object({
    ...envelope,
    eventType: z.literal('TaskAssigned'),
    data: z.object({ assigneeId: z.uuid() }),
  }),
  z.object({
    ...envelope,
    eventType: z.literal('TaskStatusChanged'),
    data: z.object({ from: openStatus, to: openStatus }),
  }),
  z.object({
    ...envelope,
    eventType: z.literal('TaskCompleted'),
    data: z.object({ completedAt: z.iso.datetime() }),
  }),
]);

/** Um evento de tarefa que mexe nos relatórios. */
export type ReportEvent = z.infer<typeof taskEventSchema>;

/** Mensagem que nunca vai ser processável: o runner a manda direto para o DLT. */
export class InvalidReportMessageError extends NonRetryableError {}

export type ParsedReportMessage =
  { kind: 'event'; event: ReportEvent } | { kind: 'ignored'; reason: string };

const HANDLED_TYPES = new Set<string>(
  taskEventSchema.options.map((option) => option.shape.eventType.value),
);

/**
 * Converte o `value` da mensagem num evento tipado.
 *
 * @throws InvalidReportMessageError para mensagem malformada de um tipo que este consumer trata.
 */
export function parseReportEvent(value: string | null): ParsedReportMessage {
  let raw: unknown;
  try {
    raw = JSON.parse(value ?? '');
  } catch {
    throw new InvalidReportMessageError('corpo da mensagem não é JSON');
  }
  const header = z
    .object({
      eventType: z.string(),
      eventVersion: z.number().int().positive(),
    })
    .safeParse(raw);
  if (!header.success) {
    throw new InvalidReportMessageError('mensagem sem eventType/eventVersion');
  }
  if (!HANDLED_TYPES.has(header.data.eventType)) {
    return {
      kind: 'ignored',
      reason: `tipo ${header.data.eventType} não entra nos relatórios`,
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
    throw new InvalidReportMessageError(
      `${header.data.eventType} inválido: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { kind: 'event', event: parsed.data };
}
