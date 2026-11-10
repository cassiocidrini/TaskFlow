import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ConsumedMessage,
  HandleResult,
} from '../../../common/messaging/kafka-consumer.runner';
import { PrismaService } from '../../../prisma/prisma.service';
import { decide, type ReportTaskState, type StatsDelta } from './report-rules';
import {
  InvalidReportMessageError,
  parseReportEvent,
  type ReportEvent,
} from './task-event.message';

/** Nome do consumer group no Kafka. */
export const REPORTS_GROUP = 'reports';

/**
 * Processa um evento de tarefa para os relatórios por projeto (Módulo 13.6a).
 *
 * **Idempotência pela VERSÃO do agregado**, e não por tabela de marcas como o `NotificationsHandler`:
 * ```
 * BEGIN
 *   SELECT report_tasks WHERE task_id = X FOR UPDATE      → versão guardada >= versão do evento: duplicata, sai
 *   UPDATE report_tasks (novo estado, versão do evento)
 *   INSERT project_stats ... ON CONFLICT DO UPDATE SET pending = pending + $delta, ...
 * COMMIT
 * ```
 * Funciona porque a projeção guarda ESTADO com uma versão monotônica, e o Kafka entrega em ordem por tarefa. A guarda
 * é `>=` (já aplicada), e não "tem que ser a versão seguinte": o contrato permite eventos internos que não são
 * publicados (o `null` do mapper, Módulo 13.2), então um buraco de versão pode ser legítimo.
 *
 * **Concorrência:**
 * - mesma tarefa: sempre na mesma partição, mas um rebalance pode deixar dois consumers com a mesma mensagem por um
 *   instante. O `FOR UPDATE` serializa, e o segundo vê a versão já aplicada;
 * - mesmo projeto: tarefas diferentes, em partições diferentes, atualizam a mesma linha de `project_stats` em
 *   paralelo. Um UPDATE com `coluna = coluna + delta` é atômico no Postgres; "ler, somar no Node e gravar" perderia
 *   atualizações (lost update). O upsert num comando só também resolve a corrida de criar a linha do projeto.
 */
@Injectable()
export class ReportsHandler {
  private readonly logger = new Logger(ReportsHandler.name);

  constructor(private readonly prisma: PrismaService) {}

  async handle(message: ConsumedMessage): Promise<HandleResult> {
    const parsed = parseReportEvent(message.value);
    if (parsed.kind === 'ignored') {
      this.logger.debug(
        `Ignorado (partição ${message.partition}, offset ${message.offset}): ${parsed.reason}`,
      );
      return 'ignored';
    }
    return this.apply(parsed.event);
  }

  private async apply(event: ReportEvent): Promise<HandleResult> {
    const taskId = event.aggregateId;
    const occurredAt = new Date(event.occurredAt);
    return this.prisma.$transaction(async (tx) => {
      if (event.eventType === 'TaskCreated') {
        const decision = decide(null, event);
        if (decision.kind !== 'apply') return 'unknown_task'; // inalcançável: TaskCreated sempre aplica
        // INSERT ... ON CONFLICT DO NOTHING: a tarefa já existe = este TaskCreated (versão 1) já foi aplicado
        const { count } = await tx.reportTask.createMany({
          data: [{ taskId, ...decision.next, version: event.aggregateVersion }],
          skipDuplicates: true,
        });
        if (count === 0) return 'duplicate';
        await createOrAddToProjectStats(
          tx,
          event.projectId,
          decision.delta,
          occurredAt,
        );
        return 'processed';
      }

      // Trava a linha da tarefa até o COMMIT: uma entrega simultânea (rebalance) espera e então vê a versão nova
      await tx.$queryRaw`SELECT task_id FROM report_tasks WHERE task_id = ${taskId}::uuid FOR UPDATE`;
      const row = await tx.reportTask.findUnique({ where: { taskId } });
      if (row && row.version >= event.aggregateVersion) return 'duplicate';
      // Uma tarefa nunca muda de projeto (o domínio não tem esse comando): evento que contradiz o estado guardado é
      // mensagem corrupta. Permanente, DLT na hora; somar o delta no projeto do evento descasaria os contadores dos
      // dois projetos (problema 26 do Módulo 13, achado com dados reais do tópico de desenvolvimento)
      if (row && row.projectId !== event.projectId) {
        throw new InvalidReportMessageError(
          `${event.eventType} da tarefa ${taskId} diz projeto ${event.projectId}, mas a tarefa é do projeto ${row.projectId}`,
        );
      }

      const decision = decide(row ? toState(row) : null, event);
      if (decision.kind === 'unknown_task') {
        this.logger.warn(
          `${event.eventType} da tarefa ${taskId} sem o TaskCreated correspondente (anterior à outbox?): fora dos relatórios até um replay`,
        );
        return 'unknown_task';
      }
      await tx.reportTask.update({
        where: { taskId },
        data: {
          status: decision.next.status,
          assigneeId: decision.next.assigneeId,
          version: event.aggregateVersion,
        },
      });
      await addToProjectStats(tx, event.projectId, decision.delta, occurredAt);
      return 'processed';
    });
  }
}

function toState(row: {
  projectId: string;
  status: ReportTaskState['status'];
  assigneeId: string | null;
  taskCreatedAt: Date;
}): ReportTaskState {
  return {
    projectId: row.projectId,
    status: row.status,
    assigneeId: row.assigneeId,
    taskCreatedAt: row.taskCreatedAt,
  };
}

/**
 * `TaskCreated`: soma o delta e CRIA a linha do projeto se for a primeira tarefa, num comando só (upsert com
 * incremento). Duas primeiras tarefas do mesmo projeto em partições diferentes não disputam o INSERT: o `ON CONFLICT`
 * resolve a corrida no banco.
 *
 * Só o `TaskCreated` passa por aqui porque todos os deltas dele são POSITIVOS. O Postgres avalia o CHECK na linha
 * candidata do INSERT antes de resolver o `ON CONFLICT`: um delta negativo no `VALUES` seria recusado mesmo indo para
 * o UPDATE (descoberto no primeiro teste, problema 25 do Módulo 13).
 *
 * SQL cru porque o Prisma não expressa `GREATEST` no `last_event_at`: eventos de partições diferentes chegam fora de
 * ordem entre si, e o "dados até" só pode avançar. Parâmetros por template tag: enviados separados do SQL (sem
 * injeção).
 */
async function createOrAddToProjectStats(
  tx: Prisma.TransactionClient,
  projectId: string,
  delta: StatsDelta,
  occurredAt: Date,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO project_stats AS s
      (project_id, total, pending, in_progress, done, unassigned_open, lead_time_seconds_sum, last_event_at, updated_at)
    VALUES
      (${projectId}::uuid, ${delta.total}, ${delta.pending}, ${delta.inProgress}, ${delta.done},
       ${delta.unassignedOpen}, ${delta.leadTimeSeconds}, ${occurredAt}, now() AT TIME ZONE 'UTC')
    ON CONFLICT (project_id) DO UPDATE SET
      total                 = s.total + EXCLUDED.total,
      pending               = s.pending + EXCLUDED.pending,
      in_progress           = s.in_progress + EXCLUDED.in_progress,
      done                  = s.done + EXCLUDED.done,
      unassigned_open       = s.unassigned_open + EXCLUDED.unassigned_open,
      lead_time_seconds_sum = s.lead_time_seconds_sum + EXCLUDED.lead_time_seconds_sum,
      last_event_at         = GREATEST(s.last_event_at, EXCLUDED.last_event_at),
      updated_at            = EXCLUDED.updated_at`;
}

/**
 * Os outros eventos: soma o delta (que pode ser negativo) à linha que o `TaskCreated` da tarefa já criou. Incremento
 * no próprio UPDATE (`coluna = coluna + delta`), atômico com outras partições mexendo no mesmo projeto.
 *
 * @throws se a linha do projeto não existir: a tarefa tem estado em `report_tasks` mas o projeto não tem contadores,
 *         o que só acontece com o banco mexido à mão. Erro `unknown`: algumas tentativas e o DLT, em vez de seguir
 *         com números que não fecham.
 */
async function addToProjectStats(
  tx: Prisma.TransactionClient,
  projectId: string,
  delta: StatsDelta,
  occurredAt: Date,
): Promise<void> {
  const updated = await tx.$executeRaw`
    UPDATE project_stats SET
      total                 = total + ${delta.total},
      pending               = pending + ${delta.pending},
      in_progress           = in_progress + ${delta.inProgress},
      done                  = done + ${delta.done},
      unassigned_open       = unassigned_open + ${delta.unassignedOpen},
      lead_time_seconds_sum = lead_time_seconds_sum + ${delta.leadTimeSeconds},
      last_event_at         = GREATEST(last_event_at, ${occurredAt}),
      updated_at            = now() AT TIME ZONE 'UTC'
    WHERE project_id = ${projectId}::uuid`;
  if (updated === 0) {
    throw new Error(
      `project_stats sem a linha do projeto ${projectId}, com a tarefa já registrada em report_tasks`,
    );
  }
}
