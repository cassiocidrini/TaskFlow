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

  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().default('http://localhost:4318'),

  // Níveis do pino. `silent` existe para os testes E2E, onde o log de acesso de cada requisição só faz ruído.
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // JSON é o padrão (formato de produção); `true` liga o pino-pretty, legível no terminal de desenvolvimento.
  LOG_PRETTY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  DISABLE_THROTTLE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
}).refine((env) => !(env.NODE_ENV === 'production' && env.LOG_PRETTY), {
  // pino-pretty é devDependency: em produção a app quebraria no primeiro log. Melhor recusar o boot com a causa.
  message: 'LOG_PRETTY=true não é permitido com NODE_ENV=production (pino-pretty é dependência só de desenvolvimento)',
  path: ['LOG_PRETTY'],
});

export type Env = z.infer<typeof envSchema>;

/**
 * Usado pelo ConfigModule.forRoot({ validate }).
 * Lança um erro legível listando TODAS as variáveis inválidas de uma vez.
 */
export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    throw new Error(
      `Variáveis de ambiente inválidas. Confira seu .env (modelo em .env.example):\n${z.prettifyError(result.error)}`,
    );
  }

  return result.data;
}
