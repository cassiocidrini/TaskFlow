/**
 * Ambiente do consumer de notificações (`consumerEnvSchema`) — Módulo 13.4.
 *
 * Mesmo contrato do relay: sobe SEM `JWT_SECRET` (menor privilégio), com defaults de desenvolvimento, e reaproveita
 * a validação de `KAFKA_BROKERS` do relay (uma regra só para os dois processos).
 */
import { validateConsumerEnv } from '../../src/config/consumer-env.schema';

describe('consumerEnvSchema', () => {
  const minimo = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

  it('deve subir só com DATABASE_URL, sem JWT_SECRET, com a porta de métricas própria', () => {
    expect(validateConsumerEnv(minimo)).toMatchObject({
      KAFKA_BROKERS: ['localhost:9092'],
      NOTIFICATIONS_METRICS_PORT: 9467,
    });
  });

  it('deve recusar broker sem porta (mesma regra do relay)', () => {
    expect(() =>
      validateConsumerEnv({ ...minimo, KAFKA_BROKERS: 'kafka' }),
    ).toThrow('Variáveis de ambiente do consumer inválidas');
  });
});
