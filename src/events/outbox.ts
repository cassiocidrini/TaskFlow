import type { EventMetadata } from './event-metadata';
import type { DomainEvent } from './event-store.service';

/**
 * Um evento como acabou de ser gravado no Event Store: o fato de domínio, o envelope, a versão que o agregado
 * ganhou com ele e o instante da gravação. É a entrada do {@link OutboxMapper}: tudo o que um evento de integração
 * pode precisar sem consultar o banco de novo.
 */
export interface RecordedEvent {
  event: DomainEvent;
  metadata: EventMetadata;
  /** Versão do agregado DEPOIS deste evento (1 = o evento de criação). */
  aggregateVersion: number;
  /** O mesmo instante gravado em `events.created_at`. */
  recordedAt: Date;
}

/**
 * Mensagem a publicar, no formato da tabela `outbox`. Destino e chave são resolvidos na gravação, para que o
 * relay (Módulo 13.3) seja genérico e não conheça nenhum agregado.
 *
 * Não tem `eventId`: o Event Store copia o `metadata.eventId` para a linha, e o mapper não tem como gravar uma
 * mensagem com uma identidade diferente da do evento que a originou.
 */
export interface OutboxMessage {
  topic: string;
  /** Chave da partição no Kafka. Para eventos de agregado, o `aggregateId`: ordem garantida por agregado. */
  key: string;
  eventType: string;
  /** O contrato PÚBLICO (evento de integração). Vira o `value` da mensagem. */
  payload: Record<string, unknown>;
}

/**
 * Traduz um evento de domínio no evento de integração que sai para fora do serviço.
 *
 * Fica com o módulo dono do agregado (ex.: `tasks/events/task.integration-events.ts`), e não no Event Store:
 * o store é compartilhado e não conhece o formato público de nenhum agregado. `null` = este evento é interno e
 * não é publicado.
 */
export type OutboxMapper = (recorded: RecordedEvent) => OutboxMessage | null;
