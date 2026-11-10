import type { Logger } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { metrics, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { contextFromCarrier } from '../telemetry/trace-context';
import { toKafkaLogger } from './kafka-logger';

/** Uma mensagem lida do Kafka, já com chave, corpo e headers como texto. */
export interface ConsumedMessage {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

/**
 * Resultado do processamento de uma mensagem, que vira o label `result` da métrica. Exemplos: `processed`,
 * `duplicate` (o consumer já tinha processado o evento), `ignored` (tipo ou versão que não interessam).
 */
export type HandleResult = string;

export interface KafkaConsumerOptions {
  brokers: string[];
  /** Consumer group: cada grupo lê o tópico INTEIRO, independente dos outros, e guarda o próprio offset. */
  groupId: string;
  topics: string[];
  /** Partições processadas em paralelo. Dentro de uma partição, sempre uma mensagem por vez (ordem). */
  partitionsConsumedConcurrently: number;
  /** O efeito. Lançar = a mensagem NÃO é commitada e volta (depois do backoff). */
  handle: (message: ConsumedMessage) => Promise<HandleResult>;
  logger: Logger;
}

/** Teto da espera entre reentregas de uma mensagem que falha. */
export const MAX_RETRY_BACKOFF_MS = 30_000;
const FIRST_RETRY_BACKOFF_MS = 500;

/**
 * Laço de um consumer group do Kafka, genérico (Módulo 13.4): conecta, processa mensagem a mensagem, commita o
 * offset e encerra com elegância. Quem decide o que fazer com a mensagem é o `handle` (no TaskFlow, os handlers de
 * cada contexto, como `NotificationsHandler`).
 *
 * **Offset commitado DEPOIS do efeito** (`autoCommit: false` + `commitOffsets` explícito). Se o processo cair entre o
 * COMMIT no banco e o commit do offset, o Kafka reentrega a mensagem: at-least-once. Por isso o `handle` precisa ser
 * idempotente (no TaskFlow, `processed_events`). Commitar ANTES do efeito seria at-most-once: um crash perderia o
 * evento sem ninguém saber.
 *
 * **Erro no `handle`:** o cliente faz *seek* de volta para a mesma mensagem e a reentrega IMEDIATAMENTE, em loop.
 * Com o banco fora, isso martelaria o Postgres. Aqui a partição espera um backoff exponencial antes de devolver o
 * erro (500 ms → 30 s); as outras partições seguem. Uma mensagem que SEMPRE falha trava a sua partição: o limite
 * de tentativas e o dead-letter topic são a etapa 13.5.
 */
export class KafkaConsumerRunner {
  private readonly consumer: KafkaJS.Consumer;
  private readonly tracer = trace.getTracer('taskflow-kafka-consumer');
  private readonly meter = metrics.getMeter('taskflow-kafka-consumer');
  private readonly messagesCounter = this.meter.createCounter(
    'kafka_consumer_messages',
    {
      description:
        'Mensagens processadas pelo consumer, por grupo e resultado (processed, duplicate, ignored, failed)',
    },
  );
  private readonly durationHistogram = this.meter.createHistogram(
    'kafka_consumer_processing_duration',
    {
      description:
        'Tempo de processamento de uma mensagem (efeito + idempotência), em segundos',
      unit: 's',
    },
  );

  /** Falhas consecutivas por partição: o backoff de uma não atrasa as outras. */
  private readonly failures = new Map<number, number>();
  private stopping = false;
  private readonly wakers = new Set<() => void>();

  constructor(private readonly options: KafkaConsumerOptions) {
    const kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers: options.brokers,
        clientId: `taskflow-${options.groupId}`,
        logLevel: KafkaJS.logLevel.WARN,
        logger: toKafkaLogger(options.logger),
      },
    });
    this.consumer = kafka.consumer({
      kafkaJS: {
        groupId: options.groupId,
        // Grupo NOVO começa do início do que o tópico retém (7 dias). Depois, sempre do offset commitado
        fromBeginning: true,
        autoCommit: false,
        // Crash (kill -9, OOM) só é percebido quando a sessão expira: as partições do morto ficam paradas até lá
        // (medido: 30,1 s). Menor = failover mais rápido, mas uma pausa longa de GC ou um processamento lento
        // derrubariam um membro saudável e causariam rebalances em cascata. SIGTERM não espera: o consumer avisa
        // o grupo ao sair (LeaveGroup) e o rebalance é imediato
        sessionTimeout: 30_000,
      },
    });
  }

  async start(): Promise<void> {
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: this.options.topics });
    // `run` resolve logo: o laço de consumo segue em segundo plano até o `stop`
    await this.consumer.run({
      partitionsConsumedConcurrently:
        this.options.partitionsConsumedConcurrently,
      eachMessage: (payload) => this.process(payload),
    });
    this.options.logger.log(
      `Consumer group "${this.options.groupId}" conectado a ${this.options.topics.join(', ')} (${this.options.partitionsConsumedConcurrently} partições em paralelo)`,
    );
  }

  /**
   * Para de buscar mensagens, interrompe backoffs em andamento e desconecta. O `disconnect` espera a mensagem em
   * processamento terminar; a que estava em backoff não é commitada e volta para quem assumir a partição.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of this.wakers) wake();
    await this.consumer.disconnect();
    this.options.logger.log(
      `Consumer group "${this.options.groupId}" desconectado`,
    );
  }

  private async process({
    topic,
    partition,
    message,
  }: KafkaJS.EachMessagePayload): Promise<void> {
    const consumed: ConsumedMessage = {
      topic,
      partition,
      offset: message.offset,
      key: message.key?.toString() ?? null,
      value: message.value?.toString() ?? null,
      headers: Object.fromEntries(
        Object.entries(message.headers ?? {}).map(([name, value]) => [
          name,
          String(value),
        ]),
      ),
    };
    const group = this.options.groupId;
    const started = performance.now();

    // Span de CONSUMER (convenção de mensageria do OTel): as queries do efeito aparecem como filhas dele.
    // PAI = o contexto do header `traceparent` (o span `create` do relay), e não um link: com uma mensagem por vez,
    // ser filho põe o consumer no MESMO trace do request que gerou o evento, que é o que se quer abrir no Jaeger.
    // Link é para quando um span processa N mensagens de traces diferentes (consumo em lote). Sem header, o span
    // vira raiz, como antes
    const parent = contextFromCarrier(consumed.headers);
    const result = await this.tracer
      .startActiveSpan(
        `process ${topic}`,
        {
          kind: SpanKind.CONSUMER,
          attributes: {
            'messaging.system': 'kafka',
            'messaging.operation.type': 'process',
            'messaging.destination.name': topic,
            'messaging.consumer.group.name': group,
            'messaging.destination.partition.id': String(partition),
            'messaging.kafka.offset': Number(message.offset),
            'messaging.message.id': consumed.headers['event-id'] ?? '',
            'taskflow.correlation_id': consumed.headers['correlation-id'] ?? '',
          },
        },
        parent,
        async (span) => {
          try {
            const handled = await this.options.handle(consumed);
            span.setAttribute('taskflow.consumer.result', handled);
            return handled;
          } catch (error) {
            span.recordException(error as Error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: describe(error),
            });
            throw error;
          } finally {
            span.end();
          }
        },
      )
      .catch(async (error: unknown) => {
        this.messagesCounter.add(1, {
          consumer_group: group,
          result: 'failed',
        });
        const attempt = (this.failures.get(partition) ?? 0) + 1;
        this.failures.set(partition, attempt);
        const delay = Math.min(
          MAX_RETRY_BACKOFF_MS,
          FIRST_RETRY_BACKOFF_MS * 2 ** (attempt - 1),
        );
        this.options.logger.error({
          msg: `Falha ao processar mensagem (tentativa ${attempt}; nova tentativa em ${delay} ms): ${describe(error)}`,
          topic,
          partition,
          offset: message.offset,
          eventId: consumed.headers['event-id'],
          correlationId: consumed.headers['correlation-id'],
        });
        await this.sleep(delay);
        throw error; // o cliente faz seek e reentrega a MESMA mensagem: nada depois dela é processado antes
      });

    this.failures.delete(partition);
    this.messagesCounter.add(1, { consumer_group: group, result });
    this.durationHistogram.record((performance.now() - started) / 1000, {
      consumer_group: group,
    });

    // Offset = PRÓXIMA mensagem a ler (por isso +1). Falha aqui não perde nada: a reentrega cai na idempotência
    try {
      await this.consumer.commitOffsets([
        { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
      ]);
    } catch (error) {
      this.options.logger.warn(
        `Commit do offset ${message.offset} (partição ${partition}) falhou; a mensagem pode ser reentregue: ${describe(error)}`,
      );
    }
  }

  /** Espera interrompível pelo `stop`. */
  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wakers.add(done);
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
