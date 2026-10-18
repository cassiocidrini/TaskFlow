import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

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
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      throw new Error(`expectedVersion inválida: ${expectedVersion}`);
    }

    const version = expectedVersion + 1;

    try {
      await this.prisma.event.create({
        data: {
          aggregateId: event.aggregateId,
          aggregateType: event.aggregateType,
          eventType: event.eventType,
          payload: event.payload as Prisma.InputJsonObject,
          version,
        },
      });
    } catch (error) {
      // P2002 = violação de unique constraint → alguém gravou essa versão antes de nós
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConcurrencyConflictError();
      }
      throw error;
    }

    return version;
  }

  async loadEvents(aggregateId: string) {
    return this.prisma.event.findMany({
      where: { aggregateId },
      orderBy: { version: 'asc' },
    });
  }
}
