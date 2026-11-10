import type { Logger } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';
import { carrierFor, contextFromCarrier } from '../telemetry/trace-context';
import {
  classifyFailure,
  DEFAULT_MAX_ATTEMPTS,
  nextStep,
  retryDelay,
  type FailureClass,
} from './consumer-errors';
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
 * `duplicate` (o consumer já tinha processado o evento), `ignored` (tipo ou versão que não interessam) e
 * {@link DEAD_LETTERED}, que o próprio runner produz.
 */
export type HandleResult = string;

/** Resultado de uma mensagem desviada para o dead-letter topic: saiu da partição, mas não foi processada. */
export const DEAD_LETTERED = 'dead_lettered';

/** Resultado de uma mensagem de replay num grupo que não aceita replay: commitada sem chamar o `handle`. */
export const IGNORED_REPLAY = 'ignored_replay';

/**
 * Resultado de uma mensagem reenviada do DLT para OUTRO grupo (header `redrive-group`, Módulo 13.6c): o redrive
 * republica no tópico de origem, que todos os grupos leem, mas só o grupo que falhou deve processar.
 */
export const IGNORED_REDRIVE = 'ignored_redrive';

/** Header que o `npm run redrive` põe na mensagem reenviada: o único grupo que deve processá-la. */
export const REDRIVE_GROUP_HEADER = 'redrive-group';

export interface KafkaConsumerOptions {
  brokers: string[];
  /** Consumer group: cada grupo lê o tópico INTEIRO, independente dos outros, e guarda o próprio offset. */
  groupId: string;
  topics: string[];
  /** Partições processadas em paralelo. Dentro de uma partição, sempre uma mensagem por vez (ordem). */
  partitionsConsumedConcurrently: number;
  /**
   * O efeito. Lançar = falha, classificada em `consumer-errors.ts`: `NonRetryableError` vai direto para o DLT, erro
   * de banco tenta para sempre, o resto tenta `maxAttempts` vezes.
   */
  handle: (message: ConsumedMessage) => Promise<HandleResult>;
  /**
   * Dead-letter topic DESTE grupo (ex.: `taskflow.notifications-dlt.v1`). Por grupo, e não um por tópico de origem:
   * a falha é do consumer, não do evento, e reprocessar a partir de um DLT compartilhado reentregaria a mensagem a
   * todos os grupos.
   */
  deadLetterTopic: string;
  /** Tentativas de uma falha desconhecida antes do DLT. Padrão: {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /**
   * O grupo aplica mensagens de replay (header `replay: true`, Módulo 13.6b)? Projeções: SIM (reconstruir é o
   * objetivo do replay). Efeitos colaterais, como notificações: NÃO (avisar de novo uma atribuição de meses atrás).
   * Obrigatório: cada grupo novo precisa decidir, em vez de herdar um padrão sem pensar.
   */
  acceptsReplay: boolean;
  logger: Logger;
}

/** Prazo do ack do DLT. Sem ele, com o Kafka fora, o envio ficaria 5 min pendurado (padrão da librdkafka). */
const DLT_SEND_TIMEOUT_MS = 10_000;
/** Tamanho máximo da mensagem de erro no header `dlt-error-message` (ver {@link headerSafe}). */
const MAX_ERROR_HEADER_LENGTH = 500;

/** Como terminou a mensagem dentro do span: concluída (inclusive no DLT) ou a tentar de novo. */
type Outcome =
  | { kind: 'done'; result: HandleResult }
  | {
      kind: 'retry';
      error: unknown;
      failure: FailureClass;
      attempt: number;
      delayMs: number;
      what: string;
    };

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
 * **Falhas (13.5): retry BLOQUEANTE na partição e dead-letter topic para a mensagem envenenada.**
 * - O cliente faz *seek* para a mensagem que falhou e a reentrega IMEDIATAMENTE, em loop. O runner espera um backoff
 *   exponencial por partição (500 ms → 30 s) antes de devolver o erro; as outras partições seguem.
 * - Bloqueante, e não tópicos de retry: um tópico de retry deixaria o `TaskCompleted` passar na frente do
 *   `TaskAssigned` que espera, e a ordem por tarefa é o que o consumer usa para saber a quem notificar.
 * - Quando a classificação manda (`consumer-errors.ts`), a mensagem vai para o DLT INTACTA, com o diagnóstico em
 *   headers, e SÓ DEPOIS do ack do DLT o offset é commitado. DLT fora = a mensagem não sai da partição (nunca se
 *   perde); crash entre o ack e o commit = ela vai ao DLT de novo (at-least-once; o `event-id` deduplica).
 * - O DLT troca ordem por disponibilidade: as mensagens seguintes da mesma tarefa passam sem a que foi desviada.
 */
export class KafkaConsumerRunner {
  private readonly consumer: KafkaJS.Consumer;
  private readonly deadLetterProducer: KafkaJS.Producer;
  private readonly maxAttempts: number;
  private readonly tracer = trace.getTracer('taskflow-kafka-consumer');
  private readonly meter = metrics.getMeter('taskflow-kafka-consumer');
  private readonly messagesCounter = this.meter.createCounter(
    'kafka_consumer_messages',
    {
      description:
        'Mensagens concluídas pelo consumer, por grupo e resultado (processed, duplicate, ignored, dead_lettered)',
    },
  );
  private readonly retriesCounter = this.meter.createCounter(
    'kafka_consumer_retries',
    {
      description:
        'Tentativas que falharam e vão se repetir, por grupo e classe da falha (permanent, infrastructure, unknown)',
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

  /**
   * Tentativas da mensagem que está falhando, por partição. Chaveado também pelo offset: a contagem é da MENSAGEM,
   * e zera quando a partição avança. Fica em memória: um restart (ou rebalance) recomeça a contagem, o que só atrasa
   * o DLT de uma falha desconhecida.
   */
  private readonly attempts = new Map<
    number,
    { offset: string; count: number }
  >();
  private stopping = false;
  private readonly wakers = new Set<() => void>();

  constructor(private readonly options: KafkaConsumerOptions) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
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
    // Idempotente, como o do relay: um reenvio por timeout de rede não duplica a mensagem no DLT
    this.deadLetterProducer = kafka.producer({
      'message.timeout.ms': DLT_SEND_TIMEOUT_MS,
      kafkaJS: { idempotent: true },
    });
  }

  async start(): Promise<void> {
    await this.deadLetterProducer.connect();
    await this.consumer.connect();
    await this.consumer.subscribe({ topics: this.options.topics });
    // `run` resolve logo: o laço de consumo segue em segundo plano até o `stop`
    await this.consumer.run({
      partitionsConsumedConcurrently:
        this.options.partitionsConsumedConcurrently,
      eachMessage: (payload) => this.process(payload),
    });
    this.options.logger.log(
      `Consumer group "${this.options.groupId}" conectado a ${this.options.topics.join(', ')} (${this.options.partitionsConsumedConcurrently} partições em paralelo; DLT ${this.options.deadLetterTopic})`,
    );
  }

  /**
   * Para de buscar mensagens, interrompe backoffs em andamento e desconecta. O `disconnect` do consumer espera a
   * mensagem em processamento terminar (inclusive um envio ao DLT); só então o produtor do DLT fecha. A mensagem
   * que estava em backoff não é commitada e volta para quem assumir a partição.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const wake of this.wakers) wake();
    await this.consumer.disconnect();
    await this.deadLetterProducer.disconnect();
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
    const outcome = await this.tracer.startActiveSpan(
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
      async (span): Promise<Outcome> => {
        try {
          if (
            !this.options.acceptsReplay &&
            consumed.headers.replay === 'true'
          ) {
            span.setAttribute('taskflow.consumer.result', IGNORED_REPLAY);
            return { kind: 'done', result: IGNORED_REPLAY };
          }
          const redriveGroup = consumed.headers[REDRIVE_GROUP_HEADER];
          if (redriveGroup !== undefined && redriveGroup !== group) {
            span.setAttribute('taskflow.consumer.result', IGNORED_REDRIVE);
            return { kind: 'done', result: IGNORED_REDRIVE };
          }
          const handled = await this.options.handle(consumed);
          span.setAttribute('taskflow.consumer.result', handled);
          return { kind: 'done', result: handled };
        } catch (error) {
          return await this.onFailure(span, consumed, error);
        } finally {
          span.end();
        }
      },
    );

    if (outcome.kind === 'retry') {
      this.retriesCounter.add(1, {
        consumer_group: group,
        error_class: outcome.failure,
      });
      this.options.logger.error({
        msg: `Falha ${outcome.what} (${outcome.failure}, tentativa ${outcome.attempt}; nova tentativa em ${outcome.delayMs} ms): ${describe(outcome.error)}`,
        topic,
        partition,
        offset: message.offset,
        eventId: consumed.headers['event-id'],
        correlationId: consumed.headers['correlation-id'],
      });
      await this.sleep(outcome.delayMs);
      throw outcome.error; // o cliente faz seek e reentrega a MESMA mensagem: nada depois dela é processado antes
    }

    this.attempts.delete(partition);
    this.messagesCounter.add(1, {
      consumer_group: group,
      result: outcome.result,
    });
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

  /** Classifica a falha, conta a tentativa e decide: tentar de novo ou desviar para o DLT. */
  private async onFailure(
    span: Span,
    consumed: ConsumedMessage,
    error: unknown,
  ): Promise<Outcome> {
    const failure = classifyFailure(error);
    const attempt = this.countAttempt(consumed.partition, consumed.offset);
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: describe(error) });
    span.setAttributes({
      'taskflow.consumer.failure_class': failure,
      'taskflow.consumer.attempt': attempt,
    });

    const step = nextStep(failure, attempt, this.maxAttempts);
    if (step.action === 'retry') {
      return {
        kind: 'retry',
        error,
        failure,
        attempt,
        delayMs: step.delayMs,
        what: 'ao processar mensagem',
      };
    }

    try {
      await this.deadLetter(consumed, error, failure, attempt);
    } catch (dltError) {
      // Sem o ack do DLT, a mensagem NÃO sai da partição: commitar agora a perderia
      span.recordException(dltError as Error);
      return {
        kind: 'retry',
        error: dltError,
        failure,
        attempt,
        delayMs: retryDelay(attempt),
        what: `ao enviar ao DLT ${this.options.deadLetterTopic}`,
      };
    }
    span.setAttribute('taskflow.consumer.result', DEAD_LETTERED);
    this.options.logger.error({
      msg: `Mensagem desviada para o DLT ${this.options.deadLetterTopic} (${failure}, ${attempt} tentativa(s)): ${describe(error)}`,
      topic: consumed.topic,
      partition: consumed.partition,
      offset: consumed.offset,
      eventId: consumed.headers['event-id'],
      correlationId: consumed.headers['correlation-id'],
    });
    return { kind: 'done', result: DEAD_LETTERED };
  }

  /**
   * Publica a mensagem no DLT e espera o ack. Chave, corpo e headers originais intactos (quem investiga vê o que
   * chegou, byte a byte); o diagnóstico vai em headers `dlt-*`. O `traceparent` passa a ser o do span de envio, que é
   * filho do `process`: no Jaeger, o desvio aparece no mesmo trace do request que gerou o evento.
   */
  private async deadLetter(
    consumed: ConsumedMessage,
    error: unknown,
    failure: FailureClass,
    attempt: number,
  ): Promise<void> {
    const dlt = this.options.deadLetterTopic;
    await this.tracer.startActiveSpan(
      `publish ${dlt}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.operation.type': 'send',
          'messaging.destination.name': dlt,
          'messaging.message.id': consumed.headers['event-id'] ?? '',
        },
      },
      async (span) => {
        try {
          const {
            traceparent: _tp,
            tracestate: _ts,
            ...original
          } = consumed.headers;
          await this.deadLetterProducer.send({
            topic: dlt,
            messages: [
              {
                key: consumed.key,
                value: consumed.value,
                headers: {
                  ...original,
                  ...carrierFor(span),
                  'dlt-original-topic': consumed.topic,
                  'dlt-original-partition': String(consumed.partition),
                  'dlt-original-offset': consumed.offset,
                  'dlt-consumer-group': this.options.groupId,
                  // `permanent` = nenhuma tentativa resolveria; `exhausted` = esgotou as tentativas de uma falha desconhecida
                  'dlt-reason':
                    failure === 'permanent' ? 'permanent' : 'exhausted',
                  'dlt-error-message': headerSafe(describe(error)),
                  'dlt-attempts': String(attempt),
                  'dlt-failed-at': new Date().toISOString(),
                },
              },
            ],
          });
        } catch (sendError) {
          span.recordException(sendError as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: describe(sendError),
          });
          throw sendError;
        } finally {
          span.end();
        }
      },
    );
  }

  private countAttempt(partition: number, offset: string): number {
    const current = this.attempts.get(partition);
    const count = current?.offset === offset ? current.count + 1 : 1;
    this.attempts.set(partition, { offset, count });
    return count;
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

/**
 * Mensagem de erro pronta para header: uma linha só (o erro do zod tem quebras de linha, que quebrariam quem lê
 * headers linha a linha, como o `kafka-console-consumer`) e com tamanho limitado (um stack trace gigante não estoura
 * o tamanho da mensagem).
 */
function headerSafe(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_ERROR_HEADER_LENGTH);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
