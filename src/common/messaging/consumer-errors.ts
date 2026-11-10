/*
 * Classificação das falhas de um consumer e a decisão do que fazer com a mensagem (Módulo 13.5).
 *
 * O dead-letter topic é para mensagem ENVENENADA, não para instabilidade. "N tentativas e DLT" sem classificar
 * esvaziaria o tópico inteiro no DLT durante 5 minutos de Postgres fora, e a culpa não era de nenhuma mensagem.
 * Por isso três classes:
 * - `permanent`: a mensagem nunca vai ser processável (contrato violado) → DLT na hora;
 * - `infrastructure`: o banco está fora ou inalcançável → tenta para sempre, com backoff; nunca DLT;
 * - `unknown`: o resto (bug, constraint inesperada) → algumas tentativas (pode ser transitório) e depois DLT.
 *
 * Funções puras: o runner só executa a decisão, e os testes unitários cobrem cada caminho sem Kafka.
 */

/**
 * Falha que nenhuma nova tentativa resolve: a mesma mensagem dá o mesmo erro. Quem lança diz "não adianta tentar
 * de novo" (ex.: `InvalidMessageError` do consumer de notificações), e o runner a manda direto para o DLT.
 */
export class NonRetryableError extends Error {}

export type FailureClass = 'permanent' | 'infrastructure' | 'unknown';

export type NextStep =
  { action: 'retry'; delayMs: number } | { action: 'dead-letter' };

/** Tentativas de uma falha `unknown` antes do DLT: 500 ms + 1 s + 2 s + 4 s de espera, ~7,5 s no total. */
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Teto da espera entre tentativas: com o banco fora, uma tentativa a cada 30 s por partição. */
export const MAX_RETRY_BACKOFF_MS = 30_000;
const FIRST_RETRY_BACKOFF_MS = 500;

/**
 * Códigos do Prisma que significam "o banco não respondeu", vistos derrubando o Postgres de verdade (Módulo 13,
 * problema 21): P1001 com o banco inalcançável (porta fechada, container parado) e P2028 com a rede travada (a
 * transação não abre em 2 s). Os outros são da mesma família na documentação do Prisma: P1002/P1008 (timeout),
 * P1017 (servidor fechou a conexão), P2024 (pool esgotado).
 */
const PRISMA_INFRASTRUCTURE_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2028',
]);

/** Erros de rede do Node, caso cheguem sem embrulho do Prisma. */
const NODE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * O banco (ou a rede até ele) falhou, e não a mensagem.
 *
 * Duas fontes, porque o código do Prisma depende do TIPO de query: a mesma conexão derrubada no meio sai como
 * P2010 num SQL cru e com outro código num `createMany`. O que não varia é o SQLSTATE do Postgres, que o adapter-pg
 * preserva em `meta.driverAdapterError.cause`: classe `08` (connection exception), `57P01`/`57P02`/`57P03` (servidor
 * desligando ou reiniciando) e `53300` (conexões esgotadas).
 */
export function isInfrastructureError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = typeof error.code === 'string' ? error.code : undefined;
  if (
    code &&
    (PRISMA_INFRASTRUCTURE_CODES.has(code) || NODE_NETWORK_CODES.has(code))
  ) {
    return true;
  }
  const cause = driverAdapterCause(error);
  if (cause?.kind === 'DatabaseNotReachable') return true;
  const sqlState =
    typeof cause?.originalCode === 'string' ? cause.originalCode : undefined;
  return (
    sqlState !== undefined &&
    (sqlState.startsWith('08') ||
      /^57P0[1-3]$/.test(sqlState) ||
      sqlState === '53300')
  );
}

export function classifyFailure(error: unknown): FailureClass {
  if (error instanceof NonRetryableError) return 'permanent';
  if (isInfrastructureError(error)) return 'infrastructure';
  return 'unknown';
}

/** Espera antes da tentativa seguinte: 500 ms, 1 s, 2 s… até {@link MAX_RETRY_BACKOFF_MS}. */
export function retryDelay(attempt: number): number {
  return Math.min(
    MAX_RETRY_BACKOFF_MS,
    FIRST_RETRY_BACKOFF_MS * 2 ** (attempt - 1),
  );
}

/**
 * O que fazer depois da `attempt`-ésima falha (1 = primeira) de uma mensagem.
 *
 * `infrastructure` nunca chega ao DLT, por mais tentativas que acumule: a partição fica parada esperando o banco, e
 * o sinal é a métrica de retries e o lag, não o DLT.
 */
export function nextStep(
  failure: FailureClass,
  attempt: number,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): NextStep {
  if (failure === 'permanent') return { action: 'dead-letter' };
  if (failure === 'unknown' && attempt >= maxAttempts) {
    return { action: 'dead-letter' };
  }
  return { action: 'retry', delayMs: retryDelay(attempt) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** `meta.driverAdapterError.cause` do Prisma 7 com driver adapter, se existir. */
function driverAdapterCause(
  error: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const meta = error.meta;
  if (!isRecord(meta) || !isRecord(meta.driverAdapterError)) return undefined;
  const cause = meta.driverAdapterError.cause;
  return isRecord(cause) ? cause : undefined;
}
