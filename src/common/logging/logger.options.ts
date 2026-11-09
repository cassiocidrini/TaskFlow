import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Params } from 'nestjs-pino';
import { isHealthCheck } from '../../health/health-paths';
import { currentCorrelationId } from '../correlation/correlation-context';

/** O subconjunto do ambiente que o logger usa (facilita o teste unitário sem montar o `Env` inteiro). */
export interface LoggerEnv {
  LOG_LEVEL: string;
  LOG_PRETTY: boolean;
}

/**
 * Nível do log de acesso conforme o resultado: 5xx é falha NOSSA (alerta), 4xx é erro do cliente (atenção,
 * mas não acorda ninguém), o resto é tráfego normal. Assim um filtro `level >= 50` mostra só o que é nosso.
 */
export function accessLogLevel(res: ServerResponse, err?: Error): 'error' | 'warn' | 'info' {
  if (err || res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  return 'info';
}

/**
 * Configuração do `nestjs-pino` (logs JSON, uma linha por evento).
 *
 * Decisões:
 * - **JSON por padrão.** O formato legível (`LOG_PRETTY=true`) é opt-in de quem desenvolve; o caminho padrão é o de
 *   produção, em que o agregador (Loki, CloudWatch, Datadog) filtra por campo em vez de usar regex.
 * - **`trace_id` e `span_id` sem código aqui:** a instrumentação do pino incluída no `getNodeAutoInstrumentations()`
 *   (`src/tracing.ts`) injeta os dois em cada linha emitida dentro de um span. Exige que o pino seja carregado DEPOIS
 *   do tracing, e a ordem de imports do `main.ts` já garante isso.
 * - **`correlationId` = id da requisição do `pino-http`** (`genReqId`), renomeado de `reqId` para `correlationId` e
 *   repetido em toda linha emitida durante a requisição (`quietReqLogger`).
 * - **Serializers por allowlist** (método, url, status): o log de acesso nunca contém headers, então
 *   `Authorization` e cookies não vazam (OWASP A09). Allowlist é mais seguro que uma lista de `redact`: um header
 *   sensível novo não precisa ser lembrado.
 */
export function buildLoggerOptions(env: LoggerEnv): Params {
  return {
    pinoHttp: {
      level: env.LOG_LEVEL,
      // Fora de uma requisição (ex.: boot) não há contexto; gerar um id evita linhas de acesso sem correlação
      genReqId: () => currentCorrelationId() ?? randomUUID(),
      customAttributeKeys: { reqId: 'correlationId' },
      quietReqLogger: true,
      // Probes rodam a cada poucos segundos: seriam ~17 mil linhas/dia por réplica sem informação nenhuma.
      // Uma falha de readiness continua no log, pelo warn do indicador e pelo log de erro do terminus.
      autoLogging: { ignore: (req: IncomingMessage) => isHealthCheck(req.url) },
      customLogLevel: (_req: IncomingMessage, res: ServerResponse, err?: Error) => accessLogLevel(res, err),
      serializers: {
        req: (req: { method: string; url: string }) => ({ method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      transport: env.LOG_PRETTY ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
    },
  };
}
