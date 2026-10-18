import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Um evento a ser gravado: a QUAL agregado pertence, de que TIPO é e o PAYLOAD (vira JSONB). */
export interface DomainEvent {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, unknown>;
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
   * @returns a nova versão do agregado.
   * @throws ConcurrencyConflictError se outra gravação já ocupou essa versão
   *         (garantido pelo UNIQUE (aggregate_id, version) no banco — sem janela de corrida).
   */
  async append(event: DomainEvent, expectedVersion: number): Promise<number> {
    return this.appendMany([event], expectedVersion);
  }

  /**
   * Grava N eventos do MESMO agregado nas versões expectedVersion+1 … expectedVersion+N.
   *
   * ATÔMICO: um único INSERT com N linhas — se qualquer versão já existir, o Postgres
   * desfaz o comando inteiro. Nunca deixa um agregado "meio salvo".
   *
   * @returns a nova versão do agregado (expectedVersion se a lista estiver vazia).
   */
  async appendMany(events: readonly DomainEvent[], expectedVersion: number): Promise<number> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error(`expectedVersion inválida: ${expectedVersion}`);
    }
    if (events.length === 0) {
      return expectedVersion;
    }

    try {
      await this.prisma.event.createMany({
        data: events.map((event, index) => ({
          aggregateId: event.aggregateId,
          aggregateType: event.aggregateType,
          eventType: event.eventType,
          payload: event.payload as Prisma.InputJsonObject,
          version: expectedVersion + 1 + index,
        })),
      });
    } catch (error) {
      // P2002 = violação de unique constraint → alguém gravou essa versão antes de nós
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConcurrencyConflictError();
      }
      throw error;
    }

    return expectedVersion + events.length;
  }

  async loadEvents(aggregateId: string) {
    return this.prisma.event.findMany({
      where: { aggregateId },
      orderBy: { version: 'asc' },
    });
  }
}
