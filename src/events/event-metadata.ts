import { z } from 'zod';

/**
 * Envelope de metadados de um evento: o CONTEXTO da gravação, separado do fato de domínio (`payload`).
 *
 * - `eventId`: identidade estável do evento, gerada na aplicação ANTES do INSERT. É o que um consumidor externo
 *   (broker, outbox) usa como chave de idempotência.
 * - `actorId`: quem emitiu o comando (o `userId` do JWT). Dado de auditoria: chega EXPLÍCITO, por parâmetro.
 * - `correlationId`: o `X-Correlation-Id` da requisição (Módulo 01). Ausente quando o evento nasce fora de HTTP.
 * - `schemaVersion`: versão do formato do `payload` daquele tipo de evento; permite evoluir o contrato com upcasters.
 *
 * Por que separado do payload: o payload é o fato de domínio (o agregado o reaplica). O envelope é infraestrutura,
 * e misturá-los faria o domínio depender de HTTP e autenticação.
 */
export interface EventMetadata {
  eventId: string;
  actorId: string;
  correlationId?: string;
  schemaVersion: number;
}

/**
 * Schema de LEITURA: tudo opcional, porque eventos gravados antes da coluna `metadata` têm `{}`. Validar na
 * fronteira transforma um JSON corrompido em erro explícito, em vez de `undefined` silencioso mais adiante.
 */
const storedMetadataSchema = z.object({
  eventId: z.string().optional(),
  actorId: z.string().optional(),
  correlationId: z.string().optional(),
  schemaVersion: z.number().int().positive().optional(),
});

/** Metadados como lidos do banco: um evento legado (`{}`) não tem autor nem `eventId`. */
export type StoredEventMetadata = z.infer<typeof storedMetadataSchema>;

/** Valida o JSONB lido do Event Store. Lança se o formato for inválido (ex.: `actorId` numérico). */
export function toEventMetadata(raw: unknown): StoredEventMetadata {
  const result = storedMetadataSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`metadata de evento inválido: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
