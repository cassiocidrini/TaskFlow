import { createServer } from 'node:net';
import {
  GenericContainer,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
import { KAFKA_TEST_IMAGE } from '../../support/kafka-image';

/** Broker de teste descartável: o endereço para os clientes e um `stop`. */
export interface TestKafka {
  /** `localhost:<porta>` — o endereço que o broker ANUNCIA, igual ao que o teste usa para conectar */
  brokers: string[];
  stop(): Promise<void>;
}

/**
 * Kafka REAL (KRaft, 1 nó) com a mesma imagem do compose — para a suíte `test:streaming`.
 *
 * Por que `GenericContainer`, e não o `KafkaContainer` do `@testcontainers/kafka`: aquele módulo só sabe subir as
 * imagens da Confluent (chama `/etc/confluent/docker/run`). Aqui a imagem é a oficial `apache/kafka`, a mesma do
 * desenvolvimento.
 *
 * O detalhe que faz funcionar: o cliente conecta no bootstrap e depois usa o endereço que o broker ANUNCIA
 * (`advertised.listeners`, ver Módulo 13). Com porta aleatória do Docker, o broker anunciaria a porta INTERNA, que o
 * host não alcança. Por isso a porta do host é escolhida ANTES de subir e mapeada de forma fixa: o anunciado e o
 * mapeado são o mesmo `localhost:<porta>`.
 */
export async function startTestKafka(): Promise<TestKafka> {
  const port = await freePort();
  const container: StartedTestContainer = await new GenericContainer(
    KAFKA_TEST_IMAGE,
  )
    .withExposedPorts({ container: 9092, host: port })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENERS: 'EXTERNAL://:9092,INTERNAL://:29092,CONTROLLER://:9093',
      KAFKA_ADVERTISED_LISTENERS: `EXTERNAL://localhost:${port},INTERNAL://localhost:29092`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP:
        'EXTERNAL:PLAINTEXT,INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'INTERNAL',
      // Como no compose: tópico é contrato, criado explicitamente pelo teste
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
      KAFKA_HEAP_OPTS: '-Xms384m -Xmx384m',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start();

  return {
    brokers: [`localhost:${port}`],
    stop: async () => {
      await container.stop();
    },
  };
}

/** Pede ao SO uma porta livre (bind na porta 0) e a devolve. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') resolve(address.port);
        else reject(new Error('não foi possível obter uma porta livre'));
      });
    });
  });
}
