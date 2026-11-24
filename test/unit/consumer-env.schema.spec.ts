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

  it('retenção de processed_events: 14 dias por padrão, e RECUSA ≤ 7 (a retenção do tópico)', () => {
    expect(validateConsumerEnv(minimo).PROCESSED_EVENTS_RETENTION_DAYS).toBe(
      14,
    );
    expect(
      validateConsumerEnv({ ...minimo, PROCESSED_EVENTS_RETENTION_DAYS: '8' })
        .PROCESSED_EVENTS_RETENTION_DAYS,
    ).toBe(8);
    expect(() =>
      validateConsumerEnv({ ...minimo, PROCESSED_EVENTS_RETENTION_DAYS: '7' }),
    ).toThrow('maior que a retenção do tópico');
  });

  it('push (13.7): sem fila = desligado; vazia no .env também; URL inválida recusa o boot', () => {
    const semFila = validateConsumerEnv(minimo);
    expect(semFila.PUSH_QUEUE_URL).toBeUndefined();
    expect(semFila.AWS_REGION).toBe('us-east-1');

    const vazias = validateConsumerEnv({
      ...minimo,
      PUSH_QUEUE_URL: '',
      AWS_ENDPOINT_URL: '',
    });
    expect(vazias.PUSH_QUEUE_URL).toBeUndefined();
    expect(vazias.AWS_ENDPOINT_URL).toBeUndefined();

    expect(() =>
      validateConsumerEnv({ ...minimo, PUSH_QUEUE_URL: 'taskflow-push' }),
    ).toThrow('PUSH_QUEUE_URL');
  });

  it('deve recusar broker sem porta (mesma regra do relay)', () => {
    expect(() =>
      validateConsumerEnv({ ...minimo, KAFKA_BROKERS: 'kafka' }),
    ).toThrow('Variáveis de ambiente do consumer inválidas');
  });
});
