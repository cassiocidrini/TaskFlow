import { z } from 'zod';

/**
 * Fonte única da verdade para as variáveis de ambiente.
 *
 * - Segredos e conexões são OBRIGATÓRIOS (sem default): se faltarem, a app não sobe.
 * - Valores não sensíveis têm default seguro para desenvolvimento.
 * - O tipo `Env` é inferido do schema: nada de `process.env.X!` espalhado pelo código.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET deve ter pelo menos 32 caracteres'),
  JWT_EXPIRES_IN: z
    .string()
    .regex(/^\d+[smhd]$/, 'JWT_EXPIRES_IN deve seguir o formato <número><s|m|h|d>, ex: 15m, 1h')
    .default('1h'),

  // Lista separada por vírgula: "http://localhost:5173,https://taskflow.app"
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.url()).min(1)),

  // Quantos proxies confiáveis há entre o cliente e a app (o `trust proxy` do Express). Com N > 0, o IP do cliente
  // (`req.ip`, a chave do rate limit) vem do X-Forwarded-For, contando N saltos a partir do fim: o último salto foi
  // escrito pelo proxy, o resto pode ter vindo do cliente. Um NÚMERO, nunca "confia em tudo": com `true`, um cliente
  // mandaria um X-Forwarded-For novo a cada requisição e nunca seria limitado. 0 (o padrão): sem proxy, o header é
  // ignorado. No Kubernetes, 1 (o Envoy do Gateway, Módulo 02, 2.5), e só é seguro porque a NetworkPolicy deixa
  // apenas o Envoy chegar à API: um pod falando direto com ela poderia forjar o header
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default('http://localhost:4318'),

  // Níveis do pino. `silent` existe para os testes E2E, onde o log de acesso de cada requisição só faz ruído.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // JSON é o padrão (formato de produção); `true` liga o pino-pretty, legível no terminal de desenvolvimento.
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // Graceful shutdown. DRAIN: quanto tempo a réplica continua atendendo com o readiness em 503 após o SIGTERM
  // (0 em dev; ~5000 em Kubernetes, onde a remoção do balanceador é assíncrona). TIMEOUT: watchdog que força a saída
  // se algum hook travar; fica abaixo dos 10 s do `docker stop` para a app sair sozinha, com log, antes do SIGKILL.
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(0),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(8_000),

  // Por quanto tempo a política de versão do app (Módulo 14.2) fica em cache: uma mudança vale em até este tempo.
  // 0 = sem cache (só nos testes E2E, que mudam a política e precisam ver o efeito na hora).
  APP_VERSION_POLICY_CACHE_TTL_MS: z.coerce.number().int().min(0).max(600_000).default(30_000),

  // Validade da Idempotency-Key do POST /tasks (Módulo 14.5): dentro dela, a mesma chave devolve a mesma resposta.
  // 24 h é o padrão de mercado (Stripe): cobre as novas tentativas de um app que ficou sem rede por horas.
  IDEMPOTENCY_KEY_TTL_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // Cache das feature flags (Módulo 14.6): um kill switch vale em todas as réplicas em até este tempo.
  // Menor que o da versão mínima (30 s) de propósito: desligar uma funcionalidade com problema não pode esperar.
  FEATURE_FLAGS_CACHE_TTL_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),

  DISABLE_THROTTLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
}).refine((env) => !(env.NODE_ENV === 'production' && env.LOG_PRETTY), {
  // pino-pretty é devDependency: em produção a app quebraria no primeiro log. Melhor recusar o boot com a causa.
  message: 'LOG_PRETTY=true não é permitido com NODE_ENV=production (pino-pretty é dependência só de desenvolvimento)',
  path: ['LOG_PRETTY'],
}).refine((env) => env.SHUTDOWN_DRAIN_MS < env.SHUTDOWN_TIMEOUT_MS, {
  // Senão o watchdog mataria a app no meio da drenagem, sempre
  message: 'SHUTDOWN_DRAIN_MS deve ser menor que SHUTDOWN_TIMEOUT_MS',
  path: ['SHUTDOWN_DRAIN_MS'],
});

export type Env = z.infer<typeof envSchema>;

/**
 * Usado pelo ConfigModule.forRoot({ validate }).
 * Lança um erro legível listando TODAS as variáveis inválidas de uma vez.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    // Texto que serve aos dois lugares onde a app roda: no desenvolvimento, as variáveis vêm do .env; num container
    // (Kubernetes, Módulo 02), do ConfigMap e do Secret, e um "confira seu .env" mandaria o plantão procurar um
    // arquivo que não existe
    throw new Error(
      `Variáveis de ambiente inválidas (no desenvolvimento, o .env; num container, o ConfigMap e o Secret; lista em .env.example):\n${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}
