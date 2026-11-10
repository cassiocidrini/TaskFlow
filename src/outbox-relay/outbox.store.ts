import { Injectable } from '@nestjs/common';
import { Prisma, type OutboxMessage as OutboxRow } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Tempo máximo de uma transação do relay (lock + leitura + envio ao Kafka + UPDATE). Maior que o timeout de envio
 * do produtor (`SEND_TIMEOUT_MS` do `KafkaMessagePublisher`), para que uma falha do Kafka chegue como erro de envio,
 * registrável, e não como transação abortada pelo Prisma.
 */
export const RELAY_TRANSACTION_TIMEOUT_MS = 20_000;

/** Linhas apagadas por comando na limpeza: DELETE curto, sem segurar lock por muito tempo. */
const CLEANUP_CHUNK = 1_000;

/** O que o relay pode fazer DENTRO da transação que segura o lock. */
export interface RelayTransaction {
  /** Pendentes em ordem de `id` (a ordem de gravação; ver `schema.prisma`). */
  pending(limit: number): Promise<OutboxRow[]>;
  markPublished(ids: readonly bigint[]): Promise<void>;
  /** Registra a tentativa que falhou, sem marcar como publicada: o lote volta na próxima rodada. */
  recordFailure(ids: readonly bigint[], error: string): Promise<void>;
}

/** Resultado de {@link OutboxStore.withRelayLock}: `acquired: false` = outra réplica está publicando um lote agora. */
export type LockResult<T> = { acquired: false } | { acquired: true; result: T };

/**
 * Acesso do relay à tabela `outbox`. Só o relay usa esta classe; quem GRAVA na outbox é o `EventStoreService`, na
 * transação dos eventos.
 */
@Injectable()
export class OutboxStore {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Executa `work` com o lock exclusivo do relay: no máximo UMA réplica publica um lote por vez.
   *
   * Por que um lote por vez, e não réplicas em paralelo com `FOR UPDATE SKIP LOCKED`: o SKIP LOCKED paraleliza, mas
   * quebra a ORDEM por tarefa. A réplica A pegaria a v1 de uma tarefa num lote, a B pegaria a v2 no lote seguinte,
   * e se a B publicasse primeiro, a v2 chegaria antes da v1. Com o lock, as réplicas REVEZAM: cada lote só é lido
   * depois do COMMIT do anterior. Se uma réplica cair, a outra pega o lock na rodada seguinte (failover sem eleição
   * de líder). Mais réplicas dão disponibilidade, não vazão.
   *
   * Por que `pg_try_advisory_xact_lock` (de TRANSAÇÃO), e não o `pg_advisory_lock` (de SESSÃO): o lock de sessão
   * pertence a UMA conexão, e o pool do Prisma entrega uma conexão qualquer a cada query; o lock e o unlock
   * cairiam em conexões diferentes. O de transação vive dentro desta `$transaction` interativa (uma conexão só) e é
   * solto pelo próprio Postgres no COMMIT/ROLLBACK, inclusive se o processo morrer no meio.
   *
   * `try`: não espera. Se outro relay tem o lock, devolve na hora e este dorme até a próxima rodada.
   */
  async withRelayLock<T>(
    work: (tx: RelayTransaction) => Promise<T>,
  ): Promise<LockResult<T>> {
    return this.prisma.$transaction(
      async (tx) => {
        // hashtext: chave numérica estável derivada de um nome legível (o advisory lock só aceita inteiros)
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtext('taskflow.outbox-relay')) AS locked`;
        if (!locked) {
          return { acquired: false } as const;
        }

        const result = await work({
          pending: (limit) =>
            tx.outboxMessage.findMany({
              where: { publishedAt: null },
              orderBy: { id: 'asc' },
              take: limit,
            }),
          markPublished: async (ids) => {
            await tx.outboxMessage.updateMany({
              where: { id: { in: [...ids] } },
              data: { publishedAt: new Date() },
            });
          },
          recordFailure: async (ids, error) => {
            await tx.outboxMessage.updateMany({
              where: { id: { in: [...ids] } },
              data: {
                attempts: { increment: 1 },
                lastError: error.slice(0, 1_000),
              },
            });
          },
        });
        return { acquired: true, result } as const;
      },
      // maxWait: espera por uma conexão livre do pool; timeout: duração máxima da transação inteira
      { maxWait: 5_000, timeout: RELAY_TRANSACTION_TIMEOUT_MS },
    );
  }

  /**
   * Apaga, em blocos, as linhas publicadas há mais de `retentionHours`. A outbox é fila de trabalho, não histórico: o
   * histórico é a tabela `events`. Guardar por um tempo (`OUTBOX_RETENTION_HOURS`) serve para investigar um
   * incidente ("este evento saiu? quando?").
   *
   * @returns quantas linhas foram apagadas.
   */
  async deletePublishedOlderThan(retentionHours: number): Promise<number> {
    let total = 0;
    for (;;) {
      // Corte calculado NO banco, em UTC: as colunas são TIMESTAMP sem fuso, gravadas em UTC pelo Prisma; o `now()`
      // puro seria convertido pelo `TimeZone` da sessão
      const deleted = await this.prisma.$executeRaw`
        DELETE FROM outbox WHERE id IN (
          SELECT id FROM outbox
          WHERE published_at < (now() AT TIME ZONE 'UTC') - make_interval(hours => ${retentionHours}::int)
          ORDER BY id LIMIT ${CLEANUP_CHUNK}
        )`;
      total += deleted;
      if (deleted < CLEANUP_CHUNK) {
        return total;
      }
    }
  }

  /**
   * Fila pendente: quantas linhas e há quantos segundos espera a mais antiga (0 se vazia). Consultado a cada coleta
   * do Prometheus, direto no banco: se o loop do relay travar, o número continua verdadeiro (cresce), em vez de
   * congelar no último valor que o loop calculou.
   */
  async pendingStats(): Promise<{ pending: number; oldestAgeSeconds: number }> {
    const [row] = await this.prisma.$queryRaw<
      { pending: number; oldest_age_seconds: number | null }[]
    >(Prisma.sql`
      SELECT count(*)::int AS pending,
             EXTRACT(EPOCH FROM (now() AT TIME ZONE 'UTC') - min(created_at))::float8 AS oldest_age_seconds
      FROM outbox WHERE published_at IS NULL`);
    return {
      pending: row.pending,
      oldestAgeSeconds: Math.max(0, row.oldest_age_seconds ?? 0),
    };
  }
}
