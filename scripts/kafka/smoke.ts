/**
 * Smoke test do Kafka: `npm run kafka:smoke` (depois de `npm run streaming:up`).
 *
 * Prova, ANTES de qualquer código da API depender de Kafka, que o cliente `@confluentinc/kafka-javascript` instala
 * (binding nativo da librdkafka) e conversa com o broker do compose:
 * 1. Admin: o tópico de eventos `taskflow.task-events.v1` existe e tem 3 partições (o contrato do `kafka-init`);
 * 2. Producer idempotente publica UMA mensagem, com chave e header, no tópico `taskflow.smoke`;
 * 3. Consumer (consumer group próprio) lê a mensagem de volta e confere chave, valor e header.
 *
 * A mensagem vai para `taskflow.smoke`, e nunca para o tópico de eventos: os consumers reais (Módulo 13.4+) leriam
 * mensagens de teste como se fossem eventos de tarefa.
 *
 * API usada: a camada compatível com KafkaJS do cliente da Confluent (`KafkaJS.Kafka`). O KafkaJS original está sem
 * manutenção; este cliente embute a librdkafka (o mesmo núcleo C dos clientes oficiais de Java/Go/Python).
 *
 * Vive em `scripts/`, e não em `src/`: ferramenta de desenvolvimento, fora do build e da imagem de produção.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { KafkaJS } from '@confluentinc/kafka-javascript';

const BROKERS = (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',');
const EVENTS_TOPIC = 'taskflow.task-events.v1';
const EXPECTED_PARTITIONS = 3;
const SMOKE_TOPIC = 'taskflow.smoke';
const TIMEOUT_MS = 30_000;

async function main(): Promise<void> {
  // logLevel WARN: no padrão (INFO), o cliente imprime cada conexão e rebalance como um objeto no console
  const kafka = new KafkaJS.Kafka({
    kafkaJS: { brokers: BROKERS, clientId: 'taskflow-smoke', logLevel: KafkaJS.logLevel.WARN },
  });
  const started = Date.now();

  // 1. Contrato do tópico de eventos
  const admin = kafka.admin();
  await admin.connect();
  const [metadata] = await admin.fetchTopicMetadata({ topics: [EVENTS_TOPIC] });
  await admin.disconnect();
  if (metadata.partitions.length !== EXPECTED_PARTITIONS) {
    throw new Error(`${EVENTS_TOPIC} tem ${metadata.partitions.length} partições; esperado ${EXPECTED_PARTITIONS}`);
  }
  console.log(`[OK] ${EVENTS_TOPIC}: ${metadata.partitions.length} partições`);

  // 2. Produz uma mensagem identificável
  const id = randomUUID();
  const producer = kafka.producer({ kafkaJS: { idempotent: true } }); // acks=all + sem duplicata em retry
  await producer.connect();
  const [delivery] = await producer.send({
    topic: SMOKE_TOPIC,
    messages: [{ key: 'smoke', value: JSON.stringify({ id }), headers: { 'x-smoke-id': id } }],
  });
  await producer.disconnect();
  console.log(`[OK] produzida em ${SMOKE_TOPIC} (partição ${delivery.partition}, offset ${delivery.baseOffset})`);

  // 3. Consome de volta. fromBeginning vale só na 1ª vez do grupo; depois ele continua do offset commitado.
  const consumer = kafka.consumer({ kafkaJS: { groupId: 'taskflow.smoke', fromBeginning: true } });
  await consumer.connect();
  await consumer.subscribe({ topics: [SMOKE_TOPIC] });

  const received = new Promise<{ partition: number; offset: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`mensagem ${id} não chegou em ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
    void consumer.run({
      eachMessage: async ({ partition, message }) => {
        const header = message.headers?.['x-smoke-id']?.toString();
        if (header !== id) return; // mensagens de execuções anteriores (retenção de 1 h)
        const value = JSON.parse(message.value?.toString() ?? '{}') as { id?: string };
        if (message.key?.toString() !== 'smoke' || value.id !== id) {
          reject(new Error('mensagem chegou corrompida (chave ou valor diferentes do enviado)'));
          return;
        }
        clearTimeout(timer);
        resolve({ partition, offset: message.offset });
      },
    });
  });

  try {
    const { partition, offset } = await received;
    console.log(`[OK] consumida pelo grupo taskflow.smoke (partição ${partition}, offset ${offset})`);
  } finally {
    await consumer.disconnect();
  }
  console.log(`[OK] Kafka respondendo em ${BROKERS.join(',')} — ida e volta em ${Date.now() - started} ms`);
}

main().catch((err: unknown) => {
  console.error('[X] Smoke test do Kafka falhou:', err instanceof Error ? err.message : err);
  console.error('    O Kafka está de pé? npm run streaming:up');
  process.exit(1);
});
