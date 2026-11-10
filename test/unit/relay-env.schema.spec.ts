/**
 * Ambiente do relay da outbox (`relayEnvSchema`) — Módulo 13.3.
 *
 * Protege o menor privilégio do processo (sobe SEM `JWT_SECRET`: o worker não deve ter o segredo que assina tokens),
 * os defaults que fazem `npm run relay:dev` funcionar só com o `.env` de desenvolvimento, e a validação da lista de
 * brokers (um `KAFKA_BROKERS=kafka` sem porta falharia só na primeira conexão, longe da causa).
 */
import { validateRelayEnv } from '../../src/config/relay-env.schema';

describe('relayEnvSchema', () => {
  const minimo = { DATABASE_URL: 'postgresql://u:p@localhost:5432/db' };

  it('deve subir só com DATABASE_URL — sem JWT_SECRET (menor privilégio) — e defaults de desenvolvimento', () => {
    expect(validateRelayEnv(minimo)).toMatchObject({
      KAFKA_BROKERS: ['localhost:9092'],
      OUTBOX_POLL_INTERVAL_MS: 500,
      OUTBOX_BATCH_SIZE: 100,
      OUTBOX_RETENTION_HOURS: 72,
      RELAY_METRICS_PORT: 9465,
    });
  });

  it('deve aceitar vários brokers separados por vírgula (com espaços)', () => {
    expect(
      validateRelayEnv({
        ...minimo,
        KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092',
      }).KAFKA_BROKERS,
    ).toEqual(['kafka-1:9092', 'kafka-2:9092']);
  });

  it.each([
    ['broker sem porta', { KAFKA_BROKERS: 'kafka' }],
    ['lote zero', { OUTBOX_BATCH_SIZE: '0' }],
    ['polling agressivo demais', { OUTBOX_POLL_INTERVAL_MS: '10' }],
    ['LOG_PRETTY em produção', { NODE_ENV: 'production', LOG_PRETTY: 'true' }],
  ])('deve recusar: %s', (_caso, extra) => {
    expect(() => validateRelayEnv({ ...minimo, ...extra })).toThrow(
      'Variáveis de ambiente do relay inválidas',
    );
  });
});
