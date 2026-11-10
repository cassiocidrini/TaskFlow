import { Injectable, Logger } from '@nestjs/common';
import { lockAggregateForOutbox } from '../events/aggregate-lock';
import { PrismaService } from '../prisma/prisma.service';
import { toReplayMessages } from './replay-messages';

export interface ReplayOptions {
  /** Só esta tarefa. Ausente = o histórico inteiro. */
  aggregateId?: string;
  /** Tarefas por transação. Padrão: 50. */
  batchSize?: number;
}

export interface ReplayReport {
  aggregates: number;
  messages: number;
}

/** Tempo máximo de uma transação de lote: ler os eventos de N tarefas e gravá-los na outbox. */
const BATCH_TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * Republica o histórico de tarefas do Event Store no Kafka, PELA OUTBOX (Módulo 13.6b).
 *
 * Pela outbox, e não direto no broker: o relay já cuida de ordem, retry, backoff e trace, e o replay não precisa
 * falar com o Kafka. As linhas saem com `replay = true` (header `replay: true`), e cada consumer group decide se
 * aplica (projeções) ou ignora (efeitos).
 *
 * Em lotes de tarefas, cada lote numa transação que:
 * 1. pega o lock de escrita de CADA tarefa do lote, em ordem (`aggregate-lock.ts`): uma gravação da API na mesma
 *    tarefa espera o COMMIT, e a ordem de id na outbox continua sendo a ordem de versão. Ordem fixa entre lotes: dois
 *    replays simultâneos não se travam (a API pega um lock só);
 * 2. lê os eventos das tarefas em ordem de versão;
 * 3. grava as mensagens na outbox, na mesma ordem.
 *
 * Paginação por chave (`aggregate_id > último`), e não por OFFSET: estável com tarefas sendo criadas durante o
 * replay (as novas entram ou não, mas nenhuma é lida duas vezes).
 */
@Injectable()
export class TaskEventReplayer {
  private readonly logger = new Logger(TaskEventReplayer.name);

  constructor(private readonly prisma: PrismaService) {}

  async replay(options: ReplayOptions = {}): Promise<ReplayReport> {
    const batchSize = options.batchSize ?? 50;
    const report: ReplayReport = { aggregates: 0, messages: 0 };
    let after: string | undefined;

    for (;;) {
      const ids = options.aggregateId
        ? after === undefined
          ? [options.aggregateId]
          : []
        : await this.nextTaskIds(after, batchSize);
      if (ids.length === 0) break;

      const messages = await this.replayBatch(ids);
      report.messages += messages;
      report.aggregates += messages > 0 ? ids.length : 0;
      after = ids[ids.length - 1];
      this.logger.log(
        `Lote republicado: ${ids.length} tarefa(s), ${messages} mensagem(ns) (total: ${report.aggregates} tarefas, ${report.messages} mensagens)`,
      );
    }
    return report;
  }

  private async nextTaskIds(
    after: string | undefined,
    limit: number,
  ): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ aggregate_id: string }[]>`
      SELECT DISTINCT aggregate_id FROM events
      WHERE aggregate_type = 'Task' AND aggregate_id > ${after ?? ''}
      ORDER BY aggregate_id
      LIMIT ${limit}`;
    return rows.map((row) => row.aggregate_id);
  }

  private replayBatch(ids: readonly string[]): Promise<number> {
    return this.prisma.$transaction(
      async (tx) => {
        for (const id of [...ids].sort()) {
          await lockAggregateForOutbox(tx, id);
        }
        const rows = await tx.event.findMany({
          where: { aggregateId: { in: [...ids] } },
          orderBy: [{ aggregateId: 'asc' }, { version: 'asc' }],
        });
        const messages = toReplayMessages(rows, new Date());
        if (messages.length > 0) {
          await tx.outboxMessage.createMany({ data: messages });
        }
        return messages.length;
      },
      { timeout: BATCH_TRANSACTION_TIMEOUT_MS },
    );
  }
}
