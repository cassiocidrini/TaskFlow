import { BeforeApplicationShutdown, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { RelayEnv } from '../config/relay-env.schema';
import { toKafkaLogger } from '../common/messaging/kafka-logger';
import { MessagePublisher, type OutgoingMessage } from './message-publisher';

/**
 * Prazo para o broker confirmar uma mensagem (`message.timeout.ms` da librdkafka). O padrão é 5 minutos: com o Kafka
 * fora do ar, o `send` ficaria pendurado esse tempo todo, segurando a transação (e o lock) do relay. Precisa ser
 * menor que o `RELAY_TRANSACTION_TIMEOUT_MS`.
 */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * Adapter Kafka da porta {@link MessagePublisher}, sobre `@confluentinc/kafka-javascript` (API compatível com
 * KafkaJS, núcleo librdkafka).
 *
 * Produtor IDEMPOTENTE (`acks=all` + número de sequência por partição): se a librdkafka reenviar uma mensagem por
 * timeout de rede, o broker descarta a cópia, e a ordem dentro da partição se mantém mesmo com retries. O que ele
 * NÃO cobre: o relay cair depois do ack e antes do COMMIT da outbox. O processo novo é outro produtor e republica
 * o lote; quem resolve essa duplicata é o consumer, pelo `eventId` (13.4).
 *
 * Conexão preguiçosa: o relay sobe mesmo com o Kafka fora do ar, e cada lote tenta conectar de novo (com o backoff
 * do relay). Derrubar o processo no boot só trocaria "fila acumulando" por "processo reiniciando em loop".
 */
@Injectable()
export class KafkaMessagePublisher
  extends MessagePublisher
  implements BeforeApplicationShutdown
{
  private readonly logger = new Logger(KafkaMessagePublisher.name);
  private readonly producer: KafkaJS.Producer;
  private connected?: Promise<void>;

  constructor(config: ConfigService<RelayEnv, true>) {
    super();
    const kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: config.get('KAFKA_BROKERS', { infer: true }),
        clientId: 'taskflow-outbox-relay',
        logLevel: KafkaJS.logLevel.WARN,
        logger: toKafkaLogger(this.logger),
      },
    });
    this.producer = kafka.producer({
      'message.timeout.ms': SEND_TIMEOUT_MS,
      kafkaJS: { idempotent: true },
    });
  }

  async publish(messages: readonly OutgoingMessage[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    await this.ensureConnected();

    // Agrupa por tópico preservando a ordem do lote dentro de cada tópico (a ordem que importa é por chave)
    const byTopic = new Map<string, KafkaJS.Message[]>();
    for (const message of messages) {
      const list = byTopic.get(message.topic) ?? [];
      list.push({
        key: message.key,
        value: message.value,
        headers: message.headers,
      });
      byTopic.set(message.topic, list);
    }

    // Resolve só quando TODAS foram confirmadas pelo broker (acks=all); qualquer falha rejeita o lote inteiro
    await this.producer.sendBatch({
      topicMessages: [...byTopic].map(([topic, topicMessages]) => ({
        topic,
        messages: topicMessages,
      })),
    });
  }

  /** Descarrega o que estiver no buffer do produtor ANTES de o Prisma e o OTel fecharem (ordem do Nest). */
  async beforeApplicationShutdown(): Promise<void> {
    if (!this.connected) {
      return;
    }
    try {
      await this.producer.disconnect();
      this.logger.log('Produtor Kafka desconectado');
    } catch (error) {
      this.logger.warn(
        `Erro ao desconectar o produtor Kafka: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async ensureConnected(): Promise<void> {
    this.connected ??= this.producer.connect().catch((error: unknown) => {
      this.connected = undefined; // a próxima rodada tenta de novo
      throw error;
    });
    await this.connected;
  }
}
