import { randomUUID } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { runWithCorrelationId } from './correlation-context';

/** Header de entrada e de saída. O Express normaliza os nomes de header recebidos para minúsculas. */
export const CORRELATION_ID_HEADER = 'X-Correlation-Id';

/** Atributo gravado no span ativo: permite buscar no Jaeger o trace de um `correlationId` citado num chamado. */
export const CORRELATION_ID_SPAN_ATTRIBUTE = 'correlation.id';

/**
 * Formato aceito: UUID, ULID, ids de outros serviços. O limite de charset e tamanho existe porque o valor vai
 * parar em TODA linha de log: sem ele, um cliente poderia injetar quebras de linha (log injection, OWASP A09)
 * ou inflar cada linha com um id de 10 KB.
 */
const VALID_CORRELATION_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Usa o id recebido se for válido; senão gera um UUID novo.
 *
 * Header inválido NÃO vira 400: correlação serve para diagnóstico e não pode derrubar uma requisição legítima.
 * Se o header vier repetido, o Node junta os valores com vírgula, o que falha na regex e gera um id novo.
 */
export function resolveCorrelationId(incoming: string | string[] | undefined): string {
  return typeof incoming === 'string' && VALID_CORRELATION_ID.test(incoming) ? incoming : randomUUID();
}

/**
 * Middleware Express (e não `NestMiddleware`): é registrado em `configureApp()` antes de qualquer outro, então o
 * id existe para todos os middlewares seguintes (inclusive o log de acesso do `pino-http`). Vale igual na produção
 * e no E2E.
 *
 * Diferença para o `trace_id` do OpenTelemetry: o `trace_id` é técnico (criado pela infraestrutura, sujeito a
 * amostragem). O `correlationId` é de negócio: o cliente (ex.: app mobile) pode gerá-lo e exibi-lo ao suporte,
 * e ele sobrevive a fronteiras onde o trace não é propagado. Os dois aparecem em cada linha de log.
 */
export function correlationIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const correlationId = resolveCorrelationId(req.headers['x-correlation-id']);

  // Devolvido em toda resposta, inclusive erros: o cliente sempre tem o id para citar
  res.setHeader(CORRELATION_ID_HEADER, correlationId);
  trace.getActiveSpan()?.setAttribute(CORRELATION_ID_SPAN_ATTRIBUTE, correlationId);

  runWithCorrelationId(correlationId, next);
}
