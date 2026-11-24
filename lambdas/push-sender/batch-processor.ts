import type { SQSBatchResponse, SQSEvent, SQSRecord } from 'aws-lambda';
import type { IdempotencyStore } from './idempotency';
import type { PushProvider } from './push-provider';
import { parsePushRequest } from './push-request';

/** Desfecho de uma mensagem do lote. Só `failed` e `in-progress` voltam para a fila. */
export type RecordOutcome = 'sent' | 'duplicate' | 'in-progress' | 'failed';

export interface Logger {
  info(message: string, fields?: object): void;
  error(message: string, fields?: object): void;
}

export interface BatchProcessorDeps {
  store: IdempotencyStore;
  provider: PushProvider;
  logger: Logger;
}

/**
 * Processa um lote de até 10 mensagens da fila de push e devolve **só as que falharam** (`batchItemFailures`).
 *
 * Por que isso importa: sem `ReportBatchItemFailures` no event source mapping, a Lambda só tem duas respostas, "o
 * lote deu certo" (o SQS apaga as 10) ou "falhou" (as 10 voltam). Uma mensagem ruim faria as 9 boas serem enviadas
 * de novo a cada tentativa, e todas iriam juntas para a DLQ no `maxReceiveCount`. Com a lista, o SQS apaga as que
 * deram certo e só as listadas ficam visíveis de novo depois do visibility timeout.
 *
 * Cada mensagem tem o seu `try`: uma exceção solta aqui derrubaria a invocação e o lote inteiro voltaria. As
 * mensagens do lote rodam em paralelo, porque push não tem ordem (é uma fila standard).
 *
 * Mensagem inválida também volta como falha: o SQS não tem "mande direto para a DLQ" (no Kafka, o runner faz isso
 * com `NonRetryableError`). Ela é tentada `maxReceiveCount` vezes (3) e então vai para a DLQ, com o motivo no log.
 */
export function createBatchProcessor(deps: BatchProcessorDeps) {
  const processRecord = async (record: SQSRecord): Promise<RecordOutcome> => {
    const context = {
      messageId: record.messageId,
      receiveCount: record.attributes.ApproximateReceiveCount,
    };
    let pushId: string | undefined;
    try {
      const push = parsePushRequest(record.body);
      pushId = push.pushId;

      const reservation = await deps.store.begin(push.pushId);
      if (reservation === 'completed') {
        deps.logger.info('push duplicado descartado', { ...context, pushId });
        return 'duplicate';
      }
      if (reservation === 'in-progress') {
        deps.logger.info('push em andamento em outra invocação', {
          ...context,
          pushId,
        });
        return 'in-progress';
      }

      try {
        await deps.provider.send(push);
      } catch (error) {
        await deps.store.release(push.pushId);
        throw error;
      }
      try {
        await deps.store.complete(push.pushId);
      } catch (error) {
        // O push JÁ saiu: devolver à fila causaria um segundo envio quando a reserva vencer. Melhor deixar a
        // reserva expirar pelo TTL e registrar.
        deps.logger.error('push enviado, mas a marca COMPLETED falhou', {
          ...context,
          pushId,
          error: describe(error),
        });
      }
      return 'sent';
    } catch (error) {
      deps.logger.error('falha ao processar push', {
        ...context,
        pushId,
        error: describe(error),
      });
      return 'failed';
    }
  };

  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    const outcomes = await Promise.all(event.Records.map(processRecord));
    const batchItemFailures = event.Records.filter((_, i) =>
      ['failed', 'in-progress'].includes(outcomes[i]),
    ).map((record) => ({ itemIdentifier: record.messageId }));

    deps.logger.info('lote processado', {
      size: event.Records.length,
      sent: outcomes.filter((o) => o === 'sent').length,
      duplicate: outcomes.filter((o) => o === 'duplicate').length,
      returnedToQueue: batchItemFailures.length,
    });
    return { batchItemFailures };
  };
}

function describe(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
