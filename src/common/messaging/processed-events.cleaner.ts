import type { Logger } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

/** Linhas apagadas por comando: lotes curtos não seguram locks nem geram uma transação gigante. */
export const CLEANUP_CHUNK = 5_000;
/** De quanto em quanto tempo cada réplica do consumer limpa (a mesma cadência da limpeza da outbox). */
export const CLEANUP_EVERY_MS = 10 * 60_000;

export interface ProcessedEventsCleanerOptions {
  consumerGroup: string;
  retentionDays: number;
  logger: Logger;
}

/**
 * Limpeza de `processed_events` por data (Módulo 13.6c): a tabela de marcas da idempotência cresce uma linha por
 * evento, para sempre, e só precisa lembrar enquanto o mesmo evento pode chegar de novo (a retenção do tópico; ver
 * `PROCESSED_EVENTS_RETENTION_DAYS`).
 *
 * Roda dentro do próprio processo do consumer, a cada {@link CLEANUP_EVERY_MS}, em lotes de {@link CLEANUP_CHUNK}.
 * Várias réplicas limpando ao mesmo tempo não quebram nada: o DELETE é idempotente, e a pior consequência é uma esperar
 * o lock de linha da outra. Falha na limpeza só é logada: nunca derruba o consumer.
 *
 * Corte calculado NO banco, em UTC: as colunas são TIMESTAMP sem fuso (a mesma regra da limpeza da outbox).
 */
export class ProcessedEventsCleaner {
  private timer?: NodeJS.Timeout;
  private running?: Promise<number>;

  constructor(
    private readonly prisma: Pick<PrismaClient, '$executeRaw'>,
    private readonly options: ProcessedEventsCleanerOptions,
  ) {}

  /** Agenda a limpeza periódica. A primeira rodada é imediata: um consumer que ficou parado limpa ao subir. */
  start(): void {
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), CLEANUP_EVERY_MS);
    // Não segura o processo vivo: quem decide o encerramento é o ciclo de vida do Nest
    this.timer.unref();
  }

  /** Para de agendar e espera a rodada em andamento terminar (o shutdown não fecha o Prisma no meio de um DELETE). */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  /** Apaga as marcas mais velhas que a retenção, em lotes, até não sobrar nenhuma. @returns quantas apagou. */
  async cleanup(): Promise<number> {
    let total = 0;
    for (;;) {
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM processed_events WHERE (consumer_group, event_id) IN (
          SELECT consumer_group, event_id FROM processed_events
          WHERE consumer_group = ${this.options.consumerGroup}
            AND processed_at < (now() AT TIME ZONE 'UTC') - make_interval(days => ${this.options.retentionDays}::int)
          LIMIT ${CLEANUP_CHUNK}
        )`;
      total += deleted;
      if (deleted < CLEANUP_CHUNK) return total;
    }
  }

  private async runOnce(): Promise<void> {
    if (this.running) return; // uma rodada lenta não empilha outra
    this.running = this.cleanup();
    try {
      const deleted = await this.running;
      if (deleted > 0) {
        this.options.logger.log(
          `Limpeza de processed_events (${this.options.consumerGroup}): ${deleted} marca(s) com mais de ${this.options.retentionDays} dias removida(s)`,
        );
      }
    } catch (error) {
      this.options.logger.warn(
        `Limpeza de processed_events falhou (tenta de novo em ${CLEANUP_EVERY_MS / 60_000} min): ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = undefined;
    }
  }
}
