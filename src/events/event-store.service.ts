import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { currentCorrelationId } from '../common/correlation/correlation-context';
import { captureTraceContext } from '../common/telemetry/trace-context';
import { PrismaService } from '../prisma/prisma.service';
import type { EventMetadata } from './event-metadata';
import type { OutboxMapper } from './outbox';

/**
 * Um evento a ser gravado: a QUAL agregado pertence, de que TIPO é, o PAYLOAD (vira JSONB) e a versão do formato
 * desse payload (`schemaVersion`, vai para o envelope de metadados).
 */
export interface DomainEvent {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, unknown>;
  schemaVersion: number;
}

/**
 * Contexto de quem grava. `actorId` é OBRIGATÓRIO e explícito: é dado de auditoria, e um contexto implícito
 * permitiria gravar eventos sem autor sem que ninguém percebesse.
 */
export interface AppendContext {
  actorId: string;
}

/**
 * Opções de gravação. `toOutbox` liga a Transactional Outbox: cada evento que o mapper traduzir vira uma linha
 * em `outbox` NA MESMA TRANSAÇÃO. Sem mapper, nada é publicado (ex.: um agregado sem contrato público).
 */
export interface AppendOptions {
  toOutbox?: OutboxMapper;
}

/** Resultado de uma gravação: a nova versão do agregado e o envelope de cada evento, na ordem recebida. */
export interface AppendResult {
  version: number;
  metadata: EventMetadata[];
}

/**
 * Outra requisição gravou no mesmo agregado depois que este comando o leu.
 * Estende ConflictException → o Nest responde 409 automaticamente.
 */
export class ConcurrencyConflictError extends ConflictException {
  constructor() {
    super('O recurso foi modificado por outra requisição. Recarregue e tente novamente.');
  }
}

/**
 * Event Store sobre PostgreSQL — a fonte da verdade do Event Sourcing.
 *
 * Tabela `events` **append-only**: linhas só são inseridas, nunca alteradas nem apagadas. Corrigir um erro é
 * gravar um NOVO evento; é isso que torna o histórico confiável para auditoria e replay.
 *
 * Por que PostgreSQL, e não um banco especializado (EventStoreDB, Kafka)? Um banco só para operar, e as duas
 * garantias de que o Event Sourcing precisa já existem aqui: `UNIQUE (aggregate_id, version)` atômico e
 * `INSERT` multi-linha atômico. Para a escala do projeto, especializar seria custo sem benefício.
 * O Kafka (Módulo 13) entra como canal de DISTRIBUIÇÃO, alimentado pela outbox, e não como fonte da verdade.
 *
 * Compartilhado (fora de `modules/`): qualquer agregado event-sourced futuro usa o mesmo store.
 */
@Injectable()
export class EventStoreService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Concorrência otimista: grava o evento na versão `expectedVersion + 1`.
   *
   * @param expectedVersion versão do agregado que o chamador LEU (0 = agregado novo, sem eventos).
   * @returns a nova versão do agregado e o envelope gravado.
   * @throws ConcurrencyConflictError se outra gravação já ocupou essa versão
   *         (garantido pelo UNIQUE (aggregate_id, version) no banco — sem janela de corrida).
   */
  async append(
    event: DomainEvent,
    expectedVersion: number,
    context: AppendContext,
    options: AppendOptions = {},
  ): Promise<AppendResult> {
    return this.appendMany([event], expectedVersion, context, options);
  }

  /**
   * Grava N eventos do MESMO agregado nas versões expectedVersion+1 … expectedVersion+N.
   *
   * ATÔMICO: um único INSERT com N linhas — se qualquer versão já existir, o Postgres
   * desfaz o comando inteiro. Nunca deixa um agregado "meio salvo".
   *
   * Transactional Outbox: com `options.toOutbox`, os eventos de integração vão para a tabela `outbox` na MESMA
   * transação. Publicar no Kafka direto daqui seria dual-write: um crash entre o COMMIT e o `send` perderia o
   * evento, e enviar antes do INSERT publicaria um evento que o 409 desfez. Com a outbox, ou o evento e a
   * mensagem existem juntos, ou nenhum dos dois; quem publica é o relay (Módulo 13.3).
   *
   * O envelope de cada evento é montado AQUI, no único ponto de escrita: `eventId` gerado antes do INSERT (quem
   * gravou já sabe a identidade do evento, sem reler o banco), `actorId` do contexto explícito e `correlationId`
   * da requisição corrente (`AsyncLocalStorage`; ausente fora de HTTP, sem inventar valor).
   *
   * O contexto de trace W3C ativo também é capturado aqui e vai para `outbox.trace_context`: a linha fica parada
   * no banco até o relay buscá-la, e sem isso o trace do `POST` terminaria no INSERT (ver `trace-context.ts`).
   *
   * @returns a nova versão do agregado (expectedVersion se a lista estiver vazia) e os envelopes gravados.
   */
  async appendMany(
    events: readonly DomainEvent[],
    expectedVersion: number,
    context: AppendContext,
    options: AppendOptions = {},
  ): Promise<AppendResult> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error(`expectedVersion inválida: ${expectedVersion}`);
    }
    if (events.length === 0) {
      return { version: expectedVersion, metadata: [] };
    }

    const correlationId = currentCorrelationId();
    const metadata = events.map(
      (event): EventMetadata => ({
        eventId: randomUUID(),
        actorId: context.actorId,
        ...(correlationId ? { correlationId } : {}),
        schemaVersion: event.schemaVersion,
      }),
    );

    // Um instante só, explícito, para `events.created_at` e o `occurredAt` do evento de integração: com o
    // DEFAULT now() do banco, os dois divergiriam por milissegundos
    const recordedAt = new Date();
    const traceContext = options.toOutbox ? captureTraceContext() : null;
    const outbox = options.toOutbox
      ? events.flatMap((event, index) => {
          const message = options.toOutbox!({
            event,
            metadata: metadata[index],
            aggregateVersion: expectedVersion + 1 + index,
            recordedAt,
          });
          // eventId vem do envelope, nunca do mapper: a mensagem é sempre ligada ao evento que a originou
          return message ? [{ ...message, eventId: metadata[index].eventId }] : [];
        })
      : [];

    const insertEvents = this.prisma.event.createMany({
      data: events.map((event, index) => ({
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        eventType: event.eventType,
        payload: event.payload as Prisma.InputJsonObject,
        metadata: { ...metadata[index] } as Prisma.InputJsonObject,
        version: expectedVersion + 1 + index,
        createdAt: recordedAt,
      })),
    });

    try {
      if (outbox.length === 0) {
        await insertEvents;
      } else {
        // Transação em lote (array), e não interativa: não há leitura entre as duas escritas. Conflito de versão
        // no primeiro INSERT desfaz também o segundo, e o erro sai como P2002 do mesmo jeito
        await this.prisma.$transaction([
          insertEvents,
          this.prisma.outboxMessage.createMany({
            data: outbox.map((message) => ({
              eventId: message.eventId,
              topic: message.topic,
              messageKey: message.key,
              eventType: message.eventType,
              payload: message.payload as Prisma.InputJsonObject,
              traceContext: traceContext ?? Prisma.DbNull,
              createdAt: recordedAt,
            })),
          }),
        ]);
      }
    } catch (error) {
      // P2002 = violação de unique constraint → alguém gravou essa versão antes de nós
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConcurrencyConflictError();
      }
      throw error;
    }

    return { version: expectedVersion + events.length, metadata };
  }

  async loadEvents(aggregateId: string) {
    return this.prisma.event.findMany({
      where: { aggregateId },
      orderBy: { version: 'asc' },
    });
  }
}
