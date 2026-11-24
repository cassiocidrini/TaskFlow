import { z } from 'zod';
import { envSchema } from './env.schema';
import { relayEnvSchema } from './relay-env.schema';

const shared = envSchema.shape;

/** URL opcional em que `VAR=` (vazia, como no `.env.example`) vale como não definida, e não como URL inválida. */
const optionalUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.url().optional(),
);

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

    /**
     * Por quantos dias a marca de "evento já processado" fica em `processed_events` (Módulo 13.6c). A marca precisa
     * durar enquanto o MESMO evento pode chegar de novo: a retenção do tópico (7 dias, `kafka-init`), dentro da qual
     * um rewind de offset reentrega tudo. Replay e redrive não estendem essa janela (o `notifications` ignora replay,
     * e um evento no DLT nunca foi marcado). Abaixo de 8 dias o schema RECUSA: seria uma janela para duplicar efeitos.
     */
    PROCESSED_EVENTS_RETENTION_DAYS: z.coerce
      .number()
      .int()
      .min(8, {
        message:
          'precisa ser maior que a retenção do tópico (7 dias): menos que isso, um rewind dentro da retenção duplicaria efeitos',
      })
      .max(365)
      .default(14),

    /**
     * Fila SQS do envio de push (Módulo 13.7). Sem ela, o consumer de notificações grava a notificação e NÃO
     * enfileira o push (`DisabledPushQueue`): é o modo do dev sem AWS, do CI e da suíte de streaming. Vazia no `.env`
     * conta como ausente.
     */
    PUSH_QUEUE_URL: optionalUrl,
    /** Região do SQS do push. Credenciais NÃO entram aqui: vêm da cadeia padrão do SDK (env no dev, role IAM na AWS). */
    AWS_REGION: z.string().min(1).default('us-east-1'),
    /** Só para LocalStack (`http://localhost:4566`). Na AWS real fica vazio: o SDK resolve o endpoint pela região. */
    AWS_ENDPOINT_URL: optionalUrl,

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
