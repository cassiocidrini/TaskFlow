import { z } from 'zod';
import { envSchema } from './env.schema';

const shared = envSchema.shape;

/**
 * Variáveis de ambiente do RELAY da outbox (`src/relay.ts`), um processo separado da API (Módulo 13.3).
 *
 * Schema próprio, e não o da API, por menor privilégio: o relay não autentica ninguém, então não recebe
 * `JWT_SECRET` (se vazar do worker, não assina tokens) nem as variáveis de HTTP. O que é comum aos dois processos
 * reaproveita a MESMA definição do `envSchema` (`shared.X`): mudar a regra de um campo muda nos dois.
 */
export const relayEnvSchema = z
  .object({
    NODE_ENV: shared.NODE_ENV,
    DATABASE_URL: shared.DATABASE_URL,
    OTEL_EXPORTER_OTLP_ENDPOINT: shared.OTEL_EXPORTER_OTLP_ENDPOINT,
    LOG_LEVEL: shared.LOG_LEVEL,
    LOG_PRETTY: shared.LOG_PRETTY,
    SHUTDOWN_TIMEOUT_MS: shared.SHUTDOWN_TIMEOUT_MS,

    /** Lista `host:porta` separada por vírgula. Do host: `localhost:9092`; de um container: `kafka:29092`. */
    KAFKA_BROKERS: z
      .string()
      .default('localhost:9092')
      .transform((value) =>
        value
          .split(',')
          .map((broker) => broker.trim())
          .filter(Boolean),
      )
      .pipe(
        z
          .array(
            z
              .string()
              .regex(/^[^\s:]+:\d+$/, 'cada broker deve ser host:porta'),
          )
          .min(1),
      ),

    /**
     * Porta do `/metrics` do relay. Em produção cada réplica tem o seu IP e o padrão basta; no mesmo host (duas
     * réplicas em desenvolvimento), a segunda precisa de outra porta, ou perde as métricas em silêncio.
     */
    RELAY_METRICS_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(9465),

    /** Espera quando a outbox está vazia. Menor = menos latência até o Kafka, mais consultas ao banco. */
    OUTBOX_POLL_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(50)
      .max(60_000)
      .default(500),
    /** Linhas por lote. Lote cheio = há fila acumulada, e o relay roda de novo sem esperar. */
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    /** Por quanto tempo uma linha JÁ PUBLICADA fica na outbox antes da limpeza (investigação de incidente). */
    OUTBOX_RETENTION_HOURS: z.coerce.number().int().min(1).max(720).default(72),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.LOG_PRETTY), {
    message: 'LOG_PRETTY=true não é permitido com NODE_ENV=production',
    path: ['LOG_PRETTY'],
  });

export type RelayEnv = z.infer<typeof relayEnvSchema>;

/** Usado pelo `ConfigModule.forRoot({ validate })` do `RelayModule`: lista todos os erros de uma vez. */
export function validateRelayEnv(config: Record<string, unknown>): RelayEnv {
  const result = relayEnvSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Variáveis de ambiente do relay inválidas:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
