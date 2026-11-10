/**
 * `OutboxRelay` — o loop que leva a outbox ao broker (Módulo 13.3), com store e publisher FALSOS.
 *
 * Protege as decisões do relay que não dependem de banco nem de Kafka:
 * - publica o lote na ordem recebida e só marca DEPOIS de o publisher resolver (ack do broker);
 * - falha no envio: registra a tentativa no lote INTEIRO e não marca nada (at-least-once, ordem acima de vazão);
 * - lock ocupado (`busy`) e banco fora: nenhuma mensagem sai;
 * - backoff exponencial com teto, zerado no primeiro sucesso; lote cheio roda de novo sem esperar;
 * - mensagem do broker: chave, corpo e headers vindos da linha da outbox;
 * - trace distribuído: cada mensagem com contexto gravado ganha um span `create` FILHO do trace de origem, e o
 *   `traceparent` do header aponta para ele; o `publish` do lote só referencia (links) os `create`;
 * - limpeza no máximo a cada 10 minutos, sem derrubar o loop se falhar;
 * - shutdown: o loop para e o `onModuleDestroy` só resolve quando a rodada em andamento terminou.
 *
 * Atomicidade, o lock de verdade e a limpeza por data estão no teste de integração (`outbox-relay.spec.ts`).
 */
import type { OutboxMessage as OutboxRow } from '@prisma/client';
import { trace } from '@opentelemetry/api';
import { carrierFor } from '../../src/common/telemetry/trace-context';
import type { ConfigService } from '@nestjs/config';
import type { RelayEnv } from '../../src/config/relay-env.schema';
import {
  MessagePublisher,
  type OutgoingMessage,
} from '../../src/outbox-relay/message-publisher';
import {
  CLEANUP_EVERY_MS,
  MAX_BACKOFF_MS,
  OutboxRelay,
  toOutgoingMessage,
} from '../../src/outbox-relay/outbox-relay.service';
import type {
  OutboxStore,
  RelayTransaction,
} from '../../src/outbox-relay/outbox.store';
import {
  startInMemoryTracing,
  type InMemoryTracing,
} from '../support/in-memory-tracing';

const row = (id: number, overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  id: BigInt(id),
  eventId: `ev-${id}`,
  topic: 'taskflow.task-events.v1',
  messageKey: 'task-1',
  eventType: 'TaskCreated',
  payload: { eventId: `ev-${id}`, correlationId: `corr-${id}` },
  createdAt: new Date(),
  publishedAt: null,
  attempts: 0,
  lastError: null,
  traceContext: null,
  ...overrides,
});

class FakePublisher extends MessagePublisher {
  readonly sent: OutgoingMessage[][] = [];
  failWith?: Error;
  async publish(messages: readonly OutgoingMessage[]): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push([...messages]);
  }
}

describe('OutboxRelay', () => {
  let pending: OutboxRow[];
  let tx: {
    pending: jest.Mock;
    markPublished: jest.Mock;
    recordFailure: jest.Mock;
  };
  let store: {
    withRelayLock: jest.Mock;
    deletePublishedOlderThan: jest.Mock;
    pendingStats: jest.Mock;
  };
  let publisher: FakePublisher;
  let relay: OutboxRelay;

  const env: Partial<RelayEnv> = {
    OUTBOX_POLL_INTERVAL_MS: 500,
    OUTBOX_BATCH_SIZE: 3,
    OUTBOX_RETENTION_HOURS: 72,
  };
  const config = {
    get: (key: keyof RelayEnv) => env[key],
  } as unknown as ConfigService<RelayEnv, true>;

  beforeEach(() => {
    pending = [];
    tx = {
      pending: jest.fn(async (limit: number) => pending.slice(0, limit)),
      markPublished: jest.fn(async (_ids: readonly bigint[]) => undefined),
      recordFailure: jest.fn(
        async (_ids: readonly bigint[], _error: string) => undefined,
      ),
    };
    store = {
      // Por padrão o lock está livre: executa o trabalho com a "transação" falsa
      withRelayLock: jest.fn(
        async (work: (t: RelayTransaction) => Promise<unknown>) => ({
          acquired: true,
          result: await work(tx as RelayTransaction),
        }),
      ),
      deletePublishedOlderThan: jest.fn(async () => 0),
      pendingStats: jest.fn(async () => ({ pending: 0, oldestAgeSeconds: 0 })),
    };
    publisher = new FakePublisher();
    relay = new OutboxRelay(store as unknown as OutboxStore, publisher, config);
  });

  describe('runCycle', () => {
    it('deve publicar o lote na ordem de id e só então marcar como publicado', async () => {
      pending = [row(1), row(2)];

      await expect(relay.runCycle()).resolves.toEqual({
        kind: 'published',
        count: 2,
      });

      expect(publisher.sent).toHaveLength(1);
      expect(publisher.sent[0].map((m) => m.headers['event-id'])).toEqual([
        'ev-1',
        'ev-2',
      ]);
      expect(tx.markPublished).toHaveBeenCalledWith([1n, 2n]);
      expect(tx.recordFailure).not.toHaveBeenCalled();
    });

    it('deve respeitar o tamanho do lote', async () => {
      pending = [row(1), row(2), row(3), row(4)];

      await relay.runCycle();

      expect(tx.pending).toHaveBeenCalledWith(3);
      expect(publisher.sent[0]).toHaveLength(3);
    });

    it('outbox vazia: não chama o publisher', async () => {
      await expect(relay.runCycle()).resolves.toEqual({
        kind: 'published',
        count: 0,
      });
      expect(publisher.sent).toHaveLength(0);
      expect(tx.markPublished).not.toHaveBeenCalled();
    });

    it('falha no envio: registra a tentativa no lote INTEIRO e não marca nada', async () => {
      pending = [row(1), row(2)];
      publisher.failWith = new Error('Local: Message timed out');

      await expect(relay.runCycle()).resolves.toEqual({
        kind: 'failed',
        error: 'Local: Message timed out',
      });

      expect(tx.recordFailure).toHaveBeenCalledWith(
        [1n, 2n],
        'Local: Message timed out',
      );
      expect(tx.markPublished).not.toHaveBeenCalled();
    });

    it('lock ocupado por outra réplica: busy, sem ler nem publicar', async () => {
      store.withRelayLock.mockResolvedValue({ acquired: false });

      await expect(relay.runCycle()).resolves.toEqual({ kind: 'busy' });
      expect(tx.pending).not.toHaveBeenCalled();
      expect(publisher.sent).toHaveLength(0);
    });

    it('banco fora (a transação lança): failed, sem derrubar o loop', async () => {
      store.withRelayLock.mockRejectedValue(new Error('Connection terminated'));

      await expect(relay.runCycle()).resolves.toEqual({
        kind: 'failed',
        error: 'Connection terminated',
      });
    });
  });

  describe('delayAfter (quanto esperar depois de uma rodada)', () => {
    it('lote cheio: 0 (há fila acumulada); lote incompleto, vazio ou busy: o intervalo de polling', () => {
      expect(relay.delayAfter({ kind: 'published', count: 3 })).toBe(0);
      expect(relay.delayAfter({ kind: 'published', count: 1 })).toBe(500);
      expect(relay.delayAfter({ kind: 'published', count: 0 })).toBe(500);
      expect(relay.delayAfter({ kind: 'busy' })).toBe(500);
    });

    it('falhas seguidas: backoff exponencial com teto, zerado no primeiro sucesso', async () => {
      pending = [row(1)];
      publisher.failWith = new Error('broker fora');
      const delays: number[] = [];
      for (let i = 0; i < 8; i++) {
        delays.push(relay.delayAfter(await relay.runCycle()));
      }

      expect(delays).toEqual([
        500,
        1_000,
        2_000,
        4_000,
        8_000,
        16_000,
        MAX_BACKOFF_MS,
        MAX_BACKOFF_MS,
      ]);

      publisher.failWith = undefined;
      await relay.runCycle(); // sucesso
      publisher.failWith = new Error('caiu de novo');
      expect(relay.delayAfter(await relay.runCycle())).toBe(500); // recomeça do início
    });
  });

  describe('toOutgoingMessage', () => {
    it('deve montar chave, corpo e headers a partir da linha da outbox', () => {
      const message = toOutgoingMessage(
        row(7, { messageKey: 'task-9', eventType: 'TaskCompleted' }),
      );

      expect(message).toEqual({
        topic: 'taskflow.task-events.v1',
        key: 'task-9',
        value: JSON.stringify({ eventId: 'ev-7', correlationId: 'corr-7' }),
        headers: {
          'event-id': 'ev-7',
          'event-type': 'TaskCompleted',
          'content-type': 'application/json',
          'correlation-id': 'corr-7',
        },
      });
    });

    it('evento sem correlationId (nascido fora de HTTP): sem o header, em vez de um valor vazio', () => {
      const message = toOutgoingMessage(
        row(1, { payload: { eventId: 'ev-1' } }),
      );

      expect(message.headers).not.toHaveProperty('correlation-id');
    });

    it('com contexto de trace: os headers W3C saem junto, com os nomes do padrão', () => {
      const traceparent =
        '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
      const message = toOutgoingMessage(row(1), {
        traceparent,
        tracestate: 'vendor=x',
      });

      expect(message.headers).toMatchObject({
        'event-id': 'ev-1',
        traceparent,
        tracestate: 'vendor=x',
      });
    });
  });

  describe('trace distribuído pela outbox', () => {
    let tracing: InMemoryTracing;
    const TOPIC = 'taskflow.task-events.v1';

    beforeAll(() => {
      tracing = startInMemoryTracing();
    });
    afterAll(async () => {
      await tracing.stop();
    });
    beforeEach(() => tracing.reset());

    /** O que a API grava em `outbox.trace_context` durante um request (span de origem já encerrado). */
    const recordedDuringRequest = () => {
      const origin = trace.getTracer('test').startSpan('POST /tasks');
      origin.end();
      return { origin: origin.spanContext(), carrier: carrierFor(origin) };
    };
    const traceparentOf = (message: OutgoingMessage) => {
      const [, traceId, spanId] = message.headers.traceparent.split('-');
      return { traceId, spanId };
    };

    it('cada mensagem continua o trace de ORIGEM: create filho do request, traceparent apontando para o create', async () => {
      const a = recordedDuringRequest();
      const b = recordedDuringRequest();
      pending = [
        row(1, { traceContext: a.carrier }),
        row(2, { traceContext: b.carrier }),
      ];

      await relay.runCycle();

      const creates = tracing.named(`create ${TOPIC}`);
      expect(creates).toHaveLength(2);
      const [sentA, sentB] = publisher.sent[0];
      for (const [origin, create, sent] of [
        [a.origin, creates[0], sentA],
        [b.origin, creates[1], sentB],
      ] as const) {
        expect(create.spanContext().traceId).toBe(origin.traceId); // mesmo trace do request
        expect(create.parentSpanContext?.spanId).toBe(origin.spanId); // filho do span gravado
        expect(traceparentOf(sent)).toEqual({
          traceId: origin.traceId,
          spanId: create.spanContext().spanId, // o consumer continua do create
        });
      }
    });

    it('o publish do lote não pertence a nenhum request: é raiz própria, com LINKS para os create', async () => {
      const a = recordedDuringRequest();
      const b = recordedDuringRequest();
      pending = [
        row(1, { traceContext: a.carrier }),
        row(2, { traceContext: b.carrier }),
      ];

      await relay.runCycle();

      const [publish] = tracing.named(`publish ${TOPIC}`);
      const creates = tracing.named(`create ${TOPIC}`);
      expect(publish.parentSpanContext).toBeUndefined();
      expect([a.origin.traceId, b.origin.traceId]).not.toContain(
        publish.spanContext().traceId,
      );
      expect(publish.links.map((l) => l.context.spanId)).toEqual(
        creates.map((c) => c.spanContext().spanId),
      );
    });

    it('linha sem contexto (gravada fora de um span): sem create e sem traceparent', async () => {
      pending = [row(1)];

      await relay.runCycle();

      expect(tracing.named(`create ${TOPIC}`)).toHaveLength(0);
      expect(publisher.sent[0][0].headers).not.toHaveProperty('traceparent');
    });
  });

  describe('cleanupIfDue', () => {
    it('deve limpar na 1ª chamada e de novo só depois de 10 minutos', async () => {
      store.deletePublishedOlderThan.mockResolvedValue(5);
      const t0 = 1_000_000_000;

      await expect(relay.cleanupIfDue(t0)).resolves.toBe(5);
      await expect(relay.cleanupIfDue(t0 + CLEANUP_EVERY_MS - 1)).resolves.toBe(
        0,
      );
      await expect(relay.cleanupIfDue(t0 + CLEANUP_EVERY_MS)).resolves.toBe(5);

      expect(store.deletePublishedOlderThan).toHaveBeenCalledTimes(2);
      expect(store.deletePublishedOlderThan).toHaveBeenCalledWith(72);
    });

    it('falha na limpeza não derruba o relay', async () => {
      store.deletePublishedOlderThan.mockRejectedValue(
        new Error('lock timeout'),
      );

      await expect(relay.cleanupIfDue()).resolves.toBe(0);
    });
  });

  describe('ciclo de vida', () => {
    it('shutdown: espera a rodada em andamento terminar e não começa outra', async () => {
      pending = [row(1)];
      let releasePublish!: () => void;
      const publishing = new Promise<void>(
        (resolve) => (releasePublish = resolve),
      );
      const publish = jest
        .spyOn(publisher, 'publish')
        .mockImplementation(async () => {
          await publishing; // lote "preso" no broker
        });

      relay.onApplicationBootstrap();
      await new Promise((resolve) => setImmediate(resolve)); // deixa a 1ª rodada começar
      const stopped = relay.onModuleDestroy();

      let done = false;
      void stopped.then(() => (done = true));
      await new Promise((resolve) => setImmediate(resolve));
      expect(done).toBe(false); // não abandona o lote no meio

      releasePublish();
      await stopped;
      expect(tx.markPublished).toHaveBeenCalledWith([1n]); // o lote em andamento terminou
      expect(publish).toHaveBeenCalledTimes(1); // e nenhum outro começou
    });
  });
});
