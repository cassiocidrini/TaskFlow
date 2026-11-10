import { z } from 'zod';
import { envSchema } from './env.schema';
import { relayEnvSchema } from './relay-env.schema';

const shared = envSchema.shape;

/**
 * Variáveis de ambiente dos processos CONSUMER do Kafka (`src/notifications-consumer.ts`, Módulo 13.4, e
 * `src/reports-consumer.ts`, Módulo 13.6a). Um schema para os dois: cada processo lê a SUA porta de métricas.
 *
 * Mesmo raciocínio do relay: schema próprio por menor privilégio (sem `JWT_SECRET`, sem variáveis HTTP). Campos
 * comuns reaproveitam a MESMA definição dos outros schemas, inclusive o `KAFKA_BROKERS` do relay.
 */
export const consumerEnvSchema = z
  .object({
    NODE_ENV: shared.NODE_ENV,
    DATABASE_URL: shared.DATABASE_URL,
    OTEL_EXPORTER_OTLP_ENDPOINT: shared.OTEL_EXPORTER_OTLP_ENDPOINT,
    LOG_LEVEL: shared.LOG_LEVEL,
    LOG_PRETTY: shared.LOG_PRETTY,
    SHUTDOWN_TIMEOUT_MS: shared.SHUTDOWN_TIMEOUT_MS,
    KAFKA_BROKERS: relayEnvSchema.shape.KAFKA_BROKERS,

    /**
     * Porta do `/metrics` do consumer de notificações (a API usa 9464 e o relay, 9465). Uma 2ª réplica no mesmo
     * host precisa de outra porta, ou perde as métricas em silêncio (problema 21 do Módulo 01).
     */
    NOTIFICATIONS_METRICS_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(9467),

    /** Porta do `/metrics` do consumer de relatórios (Módulo 13.6a). */
    REPORTS_METRICS_PORT: z.coerce
      .number()
      .int()
      .min(1)
      .max(65_535)
      .default(9468),
  })
  .refine((env) => !(env.NODE_ENV === 'production' && env.LOG_PRETTY), {
    message: 'LOG_PRETTY=true não é permitido com NODE_ENV=production',
    path: ['LOG_PRETTY'],
  });

export type ConsumerEnv = z.infer<typeof consumerEnvSchema>;

/** Usado pelo `ConfigModule.forRoot({ validate })` do módulo do consumer: lista todos os erros de uma vez. */
export function validateConsumerEnv(
  config: Record<string, unknown>,
): ConsumerEnv {
  const result = consumerEnvSchema.safeParse(config);
  if (!result.success) {
    throw new Error(
      `Variáveis de ambiente do consumer inválidas:\n${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
