import { REDRIVE_GROUP_HEADER } from '../common/messaging/kafka-consumer.runner';

/** Uma mensagem como lida do DLT. */
export interface DltMessage {
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

export type RedriveDecision =
  | {
      action: 'redrive';
      topic: string;
      key: string | null;
      value: string | null;
      headers: Record<string, string>;
      reason: string;
      eventId: string | null;
    }
  | { action: 'skip'; why: string };

/**
 * Decide se uma mensagem do DLT é reenviada e monta a mensagem para o tópico de origem (Módulo 13.6c). Função PURA.
 *
 * - **Por padrão, só `exhausted`:** esgotou as tentativas de uma falha desconhecida, provavelmente um bug que já foi
 *   corrigido. `permanent` (contrato violado) falharia igual e voltaria ao DLT; só sai com `includePermanent`, para
 *   quando o próprio contrato do consumer mudou.
 * - **Mensagem reenviada = a original:** chave, corpo e headers originais (inclusive `event-id`, que mantém a
 *   idempotência valendo), sem os `dlt-*`, mais `redrive-group` (só este grupo processa; os outros ignoram) e
 *   `redriven-at`.
 * - Mensagem de OUTRO grupo no DLT (header `dlt-consumer-group` diferente) ou sem tópico de origem: pulada.
 */
export function decideRedrive(
  message: DltMessage,
  group: string,
  options: { includePermanent: boolean; now: Date },
): RedriveDecision {
  const headers = message.headers;
  const reason = headers['dlt-reason'] ?? 'desconhecido';
  if (headers['dlt-consumer-group'] !== group) {
    return {
      action: 'skip',
      why: `é do grupo "${headers['dlt-consumer-group'] ?? '?'}", não de "${group}"`,
    };
  }
  const topic = headers['dlt-original-topic'];
  if (!topic) {
    return { action: 'skip', why: 'sem dlt-original-topic' };
  }
  if (reason === 'permanent' && !options.includePermanent) {
    return {
      action: 'skip',
      why: 'permanent (contrato violado): falharia igual; use --include-permanent se o consumer mudou',
    };
  }

  const original = Object.fromEntries(
    Object.entries(headers).filter(([name]) => !name.startsWith('dlt-')),
  );
  return {
    action: 'redrive',
    topic,
    key: message.key,
    value: message.value,
    headers: {
      ...original,
      [REDRIVE_GROUP_HEADER]: group,
      'redriven-at': options.now.toISOString(),
    },
    reason,
    eventId: headers['event-id'] ?? null,
  };
}
