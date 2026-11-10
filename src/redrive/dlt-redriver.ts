import { randomUUID } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import type { PrismaClient } from '@prisma/client';
import { toKafkaLogger } from '../common/messaging/kafka-logger';
import { decideRedrive, type DltMessage } from './redrive-message';
import { REDRIVE_POLICIES } from './redrive-policy';

export interface RedriveOptions {
  group: string;
  /** Reenvia também as `permanent` (contrato violado). Padrão: só `exhausted`. */
  includePermanent?: boolean;
  /** Lista o que seria reenviado, sem publicar nem gravar nada. */
  dryRun?: boolean;
  /** Quem pediu: vai para a auditoria (`dlt_redrives.requested_by`). */
  requestedBy: string;
}

export interface RedriveReport {
  read: number;
  redriven: number;
  alreadyRedriven: number;
  skipped: number;
}

/** Prazo do ack do tópico de origem, como o do DLT no runner. */
const SEND_TIMEOUT_MS = 10_000;
/** Tempo máximo esperando chegar ao fim da foto do DLT (um DLT grande leva mais; isto pega um broker travado). */
const READ_TIMEOUT_MS = 120_000;

/** O grupo não aceita redrive (ver `REDRIVE_POLICIES`). */
export class RedriveRefusedError extends Error {}

/**
 * Reenvia mensagens do DLT de um consumer group ao tópico de origem (Módulo 13.6c, `npm run redrive`).
 *
 * 1. **Política:** grupo sem redrive (o `reports`) ou desconhecido = {@link RedriveRefusedError}, com o caminho certo.
 * 2. **Foto do fim do DLT:** lê do início até os offsets finais do momento em que começou, e para. Mensagens que
 *    chegarem durante o comando ficam para a próxima vez.
 * 3. **Consumer temporário, sem commit:** quem lembra o que já foi reenviado é a tabela `dlt_redrives`, não um offset.
 *    Assim, uma `permanent` pulada hoje pode sair amanhã com `--include-permanent`.
 * 4. **Por mensagem:** já está em `dlt_redrives`? pula. Decide (`decideRedrive`). Publica e espera o ack. SÓ ENTÃO
 *    grava a auditoria. Crash entre os dois = reenvio repetido na próxima execução, que a idempotência do consumer
 *    absorve. O contrário (gravar antes) poderia registrar como reenviada uma mensagem que nunca saiu.
 */
export class DltRedriver {
  private readonly kafka: KafkaJS.Kafka;

  constructor(
    private readonly prisma: Pick<PrismaClient, 'dltRedrive'>,
    brokers: string[],
    private readonly logger: Logger,
  ) {
    this.kafka = new KafkaJS.Kafka({
      kafkaJS: {
        brokers,
        clientId: 'taskflow-redrive',
        logLevel: KafkaJS.logLevel.WARN,
        logger: toKafkaLogger(logger),
      },
    });
  }

  async redrive(options: RedriveOptions): Promise<RedriveReport> {
    const policy = REDRIVE_POLICIES[options.group];
    if (!policy) {
      throw new RedriveRefusedError(
        `grupo "${options.group}" sem política de redrive (conhecidos: ${Object.keys(REDRIVE_POLICIES).join(', ')})`,
      );
    }
    if (!policy.redrivable) {
      throw new RedriveRefusedError(
        `redrive recusado para "${options.group}": ${policy.instead}`,
      );
    }

    const end = await this.snapshotEnd(policy.dltTopic);
    const report: RedriveReport = {
      read: 0,
      redriven: 0,
      alreadyRedriven: 0,
      skipped: 0,
    };
    if (end.size === 0) return report;

    const producer = this.kafka.producer({
      'message.timeout.ms': SEND_TIMEOUT_MS,
      kafkaJS: { idempotent: true },
    });
    await producer.connect();
    try {
      await this.readUntil(policy.dltTopic, end, async (message) => {
        report.read += 1;
        const done = await this.prisma.dltRedrive.findUnique({
          where: {
            dltTopic_dltPartition_dltOffset: {
              dltTopic: policy.dltTopic,
              dltPartition: message.partition,
              dltOffset: BigInt(message.offset),
            },
          },
        });
        if (done) {
          report.alreadyRedriven += 1;
          return;
        }

        const decision = decideRedrive(message, options.group, {
          includePermanent: options.includePermanent ?? false,
          now: new Date(),
        });
        const where = `${policy.dltTopic}[${message.partition}]@${message.offset}`;
        if (decision.action === 'skip') {
          report.skipped += 1;
          this.logger.log(`Pulada ${where}: ${decision.why}`);
          return;
        }
        const summary = `${where} → ${decision.topic} (${decision.reason}; event-id ${decision.eventId ?? '?'}; erro: ${message.headers['dlt-error-message'] ?? '?'})`;
        if (options.dryRun) {
          report.redriven += 1;
          this.logger.log(`[dry-run] Seria reenviada ${summary}`);
          return;
        }

        await producer.send({
          topic: decision.topic,
          messages: [
            {
              key: decision.key,
              value: decision.value,
              headers: decision.headers,
            },
          ],
        });
        await this.prisma.dltRedrive.create({
          data: {
            consumerGroup: options.group,
            dltTopic: policy.dltTopic,
            dltPartition: message.partition,
            dltOffset: BigInt(message.offset),
            eventId: decision.eventId,
            reason: decision.reason,
            requestedBy: options.requestedBy,
          },
        });
        report.redriven += 1;
        this.logger.log(`Reenviada ${summary}`);
      });
    } finally {
      await producer.disconnect();
    }
    return report;
  }

  /** Último offset de cada partição COM mensagens no momento da chamada (partição vazia fica de fora). */
  private async snapshotEnd(topic: string): Promise<Map<number, bigint>> {
    const admin = this.kafka.admin();
    await admin.connect();
    try {
      const offsets = await admin.fetchTopicOffsets(topic);
      return new Map(
        offsets
          .filter((p) => BigInt(p.high) > BigInt(p.low))
          .map((p) => [p.partition, BigInt(p.high) - 1n]),
      );
    } finally {
      await admin.disconnect();
    }
  }

  /** Lê o tópico do início até o offset de `end` em cada partição, uma mensagem por vez, e para. */
  private async readUntil(
    topic: string,
    end: Map<number, bigint>,
    onMessage: (message: DltMessage) => Promise<void>,
  ): Promise<void> {
    const pending = new Set(end.keys());
    const consumer = this.kafka.consumer({
      kafkaJS: {
        // Grupo descartável: o progresso fica em `dlt_redrives`, não em offset
        groupId: `taskflow-redrive-${randomUUID()}`,
        fromBeginning: true,
        autoCommit: false,
      },
    });
    let finished!: () => void;
    let failed!: (error: unknown) => void;
    // Depois de uma falha, nenhuma mensagem seguinte é reenviada: o comando para e reporta
    let stopped = false;
    const done = new Promise<void>((resolve, reject) => {
      finished = resolve;
      failed = (error) => {
        stopped = true;
        reject(error);
      };
    });

    await consumer.connect();
    try {
      await consumer.subscribe({ topics: [topic] });
      await consumer.run({
        eachMessage: async ({ partition, message }) => {
          const last = end.get(partition);
          if (stopped || last === undefined || BigInt(message.offset) > last) {
            return; // falhou antes, ou chegou depois da foto
          }
          try {
            await onMessage({
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
            });
          } catch (error) {
            failed(error);
            return;
          }
          if (BigInt(message.offset) === last) {
            pending.delete(partition);
            if (pending.size === 0) finished();
          }
        },
      });

      const timeout = setTimeout(
        () =>
          failed(
            new Error(
              `redrive não chegou ao fim do DLT em ${READ_TIMEOUT_MS / 1000} s (partições pendentes: ${[...pending].join(', ')})`,
            ),
          ),
        READ_TIMEOUT_MS,
      );
      try {
        await done;
      } finally {
        clearTimeout(timeout);
      }
    } finally {
      await consumer.disconnect();
    }
  }
}
