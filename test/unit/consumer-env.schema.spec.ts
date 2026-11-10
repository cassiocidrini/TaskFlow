/**
 * Ambiente dos consumers do Kafka (`consumerEnvSchema`) — Módulos 13.4 e 13.6a.
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
      REPORTS_METRICS_PORT: 9468, // cada consumer na sua porta: dois no mesmo host não disputam a 9467
    });
  });

  it('deve recusar broker sem porta (mesma regra do relay)', () => {
    expect(() =>
      validateConsumerEnv({ ...minimo, KAFKA_BROKERS: 'kafka' }),
    ).toThrow('Variáveis de ambiente do consumer inválidas');
  });
});
