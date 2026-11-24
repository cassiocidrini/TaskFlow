import { createHash } from 'node:crypto';
import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { stableStringify } from '../json/stable-json';

/** Header de entrada (draft-ietf-httpapi-idempotency-key-header) e o de saída que marca uma resposta repetida. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * 1 a 255 caracteres ASCII visíveis, sem espaço. O recomendado ao cliente é um UUID v4 por INTENÇÃO (gerado quando o
 * usuário toca em "criar", e reaproveitado em toda nova tentativa daquela mesma ação), mas o formato não é imposto:
 * a chave é do cliente. O limite existe porque o valor vira chave primária e aparece em logs.
 */
const VALID_KEY = /^[\x21-\x7E]{1,255}$/;

/**
 * Lê o header. Ausente: `undefined` (o header é OPCIONAL: exigi-lo quebraria os apps instalados). Presente e inválido
 * (vazio, longo demais, repetido, com espaço ou caractere de controle): 400, porque, ao contrário do `X-App-Version`,
 * aqui o cliente PEDIU uma garantia, e ignorar a chave em silêncio poderia criar o duplicado que ele quis evitar.
 */
export function parseIdempotencyKey(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !VALID_KEY.test(raw)) {
    throw new BadRequestException(
      `${IDEMPOTENCY_KEY_HEADER} inválida: de 1 a 255 caracteres ASCII visíveis, sem espaços (recomendado: um UUID v4)`,
    );
  }
  return raw;
}

/**
 * O que define "o MESMO pedido": método, rota (com o `projectId`) e corpo, numa serialização estável (a ordem das chaves
 * do JSON não importa). A mesma chave com outro hash é a chave de outra intenção, reaproveitada por engano: 422.
 */
export function requestHash(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(stableStringify({ method, path, body }))
    .digest('hex');
}

/** O cliente reaproveitou a chave num pedido diferente: um bug no app, que precisa de outra chave para outra intenção. */
export class IdempotencyKeyReusedError extends UnprocessableEntityException {
  constructor() {
    super({
      statusCode: 422,
      error: 'Unprocessable Entity',
      code: 'IDEMPOTENCY_KEY_REUSED',
      message: `Esta ${IDEMPOTENCY_KEY_HEADER} já foi usada num pedido diferente. Use uma chave nova para cada intenção.`,
    });
  }
}
