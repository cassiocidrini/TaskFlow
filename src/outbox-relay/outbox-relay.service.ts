import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OutboxMessage as OutboxRow } from '@prisma/client';
import {
  metrics,
  SpanKind,
  SpanStatusCode,
  trace,
  type BatchObservableCallback,
} from '@opentelemetry/api';
import type { RelayEnv } from '../config/relay-env.schema';
import { MessagePublisher, type OutgoingMessage } from './message-publisher';
import { OutboxStore } from './outbox.store';

/** Teto do backoff exponencial com o Kafka (ou o banco) com problema. */
export const MAX_BACKOFF_MS = 30_000;
/** De quanto em quanto tempo cada réplica do relay apaga as linhas publicadas além da retenção. */
export const CLEANUP_EVERY_MS = 10 * 60_000;

/**
 * Resultado de uma rodada:
 * - `busy`: outra réplica está com o lock (publicando um lote agora); esta não fez nada;
 * - `published`: o lote saiu e foi marcado (`count = 0` = outbox vazia);
 * - `failed`: o envio ou o banco falhou; o lote continua pendente e volta na próxima rodada.
 */
export type CycleOutcome =
  | { kind: 'busy' }
  | { kind: 'published'; count: number }
  | { kind: 'failed'; error: string };

/**
 * Relay da Transactional Outbox (Módulo 13.3): lê as linhas pendentes da `outbox`, publica no broker e as marca
 * como publicadas. Roda no processo `src/relay.ts`, separado da API.
 *
 * Cada rodada, numa transação só (ver `OutboxStore.withRelayLock`):
 * `lock → SELECT pendentes ORDER BY id LIMIT n → publish (espera o ack) → UPDATE published_at → COMMIT`.
 *
 * Garantias e escolhas:
 * - **At-least-once.** Cair entre o ack do broker e o COMMIT republica o lote. Nunca perde; pode duplicar (o
 *   consumer deduplica pelo `eventId`, 13.4).
 * - **Ordem acima de vazão.** Falhou? O lote INTEIRO volta, e nada depois dele sai antes. Pular a mensagem que falha
 *   publicaria a v2 de uma tarefa antes da v1. Custo: uma mensagem com erro permanente trava a fila, e isso aparece
 *   em `outbox_oldest_pending_age_seconds` e no `last_error` da linha.
 * - **Backoff exponencial** nas falhas (até {@link MAX_BACKOFF_MS}): sem martelar um Kafka que está caindo.
 * - **Lote cheio = roda de novo na hora** (há fila acumulada); lote incompleto = espera `OUTBOX_POLL_INTERVAL_MS`.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly retentionHours: number;

  private loop?: Promise<void>;
  private stopping = false;
  private wake?: () => void;
  private consecutiveFailures = 0;
  private lastCleanupAt = 0;

  // Sem SDK registrado (testes), a API do OTel devolve instrumentos no-op: nada a desligar no teste
  private readonly meter = metrics.getMeter('taskflow-relay');
  private readonly tracer = trace.getTracer('taskflow-relay');
  private readonly publishedCounter = this.meter.createCounter(
    'outbox_relay_published',
    {
      description: 'Mensagens publicadas no broker e marcadas na outbox',
    },
  );
  private readonly failuresCounter = this.meter.createCounter(
    'outbox_relay_failures',
    {
      description: 'Rodadas do relay que falharam (envio ao broker ou banco)',
    },
  );
  private readonly pendingGauge = this.meter.createObservableGauge(
    'outbox_pending_messages',
    {
      description: 'Linhas da outbox ainda não publicadas',
    },
  );
  private readonly oldestAgeGauge = this.meter.createObservableGauge(
    'outbox_oldest_pending_age_seconds',
    {
      description:
        'Há quanto tempo espera a mensagem pendente mais antiga (0 = fila vazia). O sinal de alerta do relay',
    },
  );
  private readonly observeQueue: BatchObservableCallback = async (result) => {
    try {
      const { pending, oldestAgeSeconds } = await this.store.pendingStats();
      result.observe(this.pendingGauge, pending);
      result.observe(this.oldestAgeGauge, oldestAgeSeconds);
    } catch {
      // Banco fora: sem amostra nesta coleta. O alerta vem do próprio `up`/falhas, não de um valor inventado
    }
  };

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: MessagePublisher,
    config: ConfigService<RelayEnv, true>,
  ) {
    this.pollIntervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', {
      infer: true,
    });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.retentionHours = config.get('OUTBOX_RETENTION_HOURS', { infer: true });
  }

  onApplicationBootstrap(): void {
    this.meter.addBatchObservableCallback(this.observeQueue, [
      this.pendingGauge,
      this.oldestAgeGauge,
    ]);
    this.logger.log(
      `Relay iniciado: lote de ${this.batchSize}, polling a cada ${this.pollIntervalMs} ms, retenção de ${this.retentionHours} h`,
    );
    this.loop = this.run();
  }

  /**
   * Primeiro passo do graceful shutdown: para de pegar lotes novos, acorda o loop se estiver dormindo e ESPERA a
   * rodada em andamento terminar (COMMIT ou ROLLBACK). Só depois o produtor desconecta e o Prisma fecha.
   */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    this.meter.removeBatchObservableCallback(this.observeQueue, [
      this.pendingGauge,
      this.oldestAgeGauge,
    ]);
    this.logger.log('Relay parado (nenhum lote em andamento)');
  }

  /** Uma rodada completa. Pública para os testes conduzirem o relay passo a passo, sem timers. */
  async runCycle(): Promise<CycleOutcome> {
    let outcome: CycleOutcome;
    try {
      const lock = await this.store.withRelayLock(
        async (tx): Promise<CycleOutcome> => {
          const rows = await tx.pending(this.batchSize);
          if (rows.length === 0) {
            return { kind: 'published', count: 0 };
          }
          const ids = rows.map((row) => row.id);
          try {
            await this.publishWithSpan(rows);
          } catch (error) {
            const message = describe(error);
            // Registra a tentativa e faz COMMIT (não rollback): `attempts`/`last_error` ficam para o diagnóstico
            await tx.recordFailure(ids, message);
            return { kind: 'failed', error: message };
          }
          await tx.markPublished(ids);
          return { kind: 'published', count: rows.length };
        },
      );
      outcome = lock.acquired ? lock.result : { kind: 'busy' };
    } catch (error) {
      // Banco fora, timeout da transação: nada foi marcado, o lote volta inteiro
      outcome = { kind: 'failed', error: describe(error) };
    }

    this.record(outcome);
    return outcome;
  }

  /** Quanto esperar depois de uma rodada. Pública e pura: o backoff é testado sem relógio. */
  delayAfter(outcome: CycleOutcome): number {
    switch (outcome.kind) {
      case 'failed':
        return Math.min(
          MAX_BACKOFF_MS,
          this.pollIntervalMs * 2 ** Math.max(0, this.consecutiveFailures - 1),
        );
      case 'published':
        return outcome.count >= this.batchSize ? 0 : this.pollIntervalMs;
      case 'busy':
        return this.pollIntervalMs;
    }
  }

  /** Limpeza das publicadas além da retenção, no máximo a cada {@link CLEANUP_EVERY_MS}. Pública para os testes. */
  async cleanupIfDue(now = Date.now()): Promise<number> {
    if (now - this.lastCleanupAt < CLEANUP_EVERY_MS) {
      return 0;
    }
    this.lastCleanupAt = now;
    try {
      const deleted = await this.store.deletePublishedOlderThan(
        this.retentionHours,
      );
      if (deleted > 0) {
        this.logger.log(
          `Limpeza da outbox: ${deleted} linhas publicadas há mais de ${this.retentionHours} h removidas`,
        );
      }
      return deleted;
    } catch (error) {
      this.logger.warn(
        `Limpeza da outbox falhou (tenta de novo em ${CLEANUP_EVERY_MS / 60_000} min): ${describe(error)}`,
      );
      return 0;
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const outcome = await this.runCycle();
      // Limpa quem acabou de publicar; uma réplica que encontrou o lock ocupado não disputa o DELETE
      if (outcome.kind === 'published') {
        await this.cleanupIfDue();
      }
      await this.sleep(this.delayAfter(outcome));
    }
  }

  private async publishWithSpan(rows: readonly OutboxRow[]): Promise<void> {
    // Span de PRODUCER (convenção semântica de mensageria do OTel): aparece no Jaeger como "publish <tópico>"
    const topics = [...new Set(rows.map((row) => row.topic))];
    await this.tracer.startActiveSpan(
      `publish ${topics.join(',')}`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          'messaging.system': 'kafka',
          'messaging.operation.type': 'send',
          'messaging.destination.name': topics.join(','),
          'messaging.batch.message_count': rows.length,
        },
      },
      async (span) => {
        try {
          await this.publisher.publish(rows.map(toOutgoingMessage));
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
    );
  }

  /** Métricas e logs SÓ de transições (falhou / voltou), para o log não repetir a mesma linha a cada 500 ms. */
  private record(outcome: CycleOutcome): void {
    if (outcome.kind === 'busy') {
      // Normal com mais de uma réplica: elas revezam o lock a cada rodada. Debug, senão o log alternaria sem parar
      this.logger.debug(
        'Outra réplica do relay está publicando um lote; tento na próxima rodada',
      );
      return;
    }

    if (outcome.kind === 'failed') {
      this.consecutiveFailures += 1;
      this.failuresCounter.add(1);
      this.logger.error(
        `Falha ao publicar a outbox (falha consecutiva nº ${this.consecutiveFailures}; nova tentativa em ${this.delayAfter(outcome)} ms): ${outcome.error}`,
      );
      return;
    }

    if (this.consecutiveFailures > 0) {
      this.logger.log(
        `Publicação restabelecida após ${this.consecutiveFailures} falha(s) consecutiva(s)`,
      );
    }
    this.consecutiveFailures = 0;
    if (outcome.count > 0) {
      this.publishedCounter.add(outcome.count);
      this.logger.debug(`${outcome.count} mensagem(ns) publicada(s)`);
    }
  }

  /** Espera interrompível: o shutdown não aguarda o fim de um backoff de 30 s. */
  private sleep(ms: number): Promise<void> {
    if (ms <= 0 || this.stopping) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
}

/**
 * Linha da outbox → mensagem do broker. Os headers repetem o essencial do envelope para o consumer rotear, filtrar
 * e logar SEM fazer parse do corpo. O `correlation-id` sai do envelope do contrato quando existir (eventos nascidos
 * fora de HTTP não têm).
 */
export function toOutgoingMessage(row: OutboxRow): OutgoingMessage {
  const payload = row.payload as Record<string, unknown>;
  const headers: Record<string, string> = {
    'event-id': row.eventId,
    'event-type': row.eventType,
    'content-type': 'application/json',
  };
  if (typeof payload.correlationId === 'string') {
    headers['correlation-id'] = payload.correlationId;
  }
  return {
    topic: row.topic,
    key: row.messageKey,
    value: JSON.stringify(payload),
    headers,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
