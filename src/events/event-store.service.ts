import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface DomainEvent {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, unknown>;
}

@Injectable()
export class EventStoreService {
  constructor(private readonly prisma: PrismaService) {}

  async append(event: DomainEvent): Promise<void> {
    const lastEvent = await this.prisma.event.findFirst({
      where: { aggregateId: event.aggregateId },
      orderBy: { version: 'desc' },
    });

    const nextVersion = (lastEvent?.version ?? 0) + 1;

    await this.prisma.event.create({
      data: {
        aggregateId: event.aggregateId,
        aggregateType: event.aggregateType,
        eventType: event.eventType,
        // Prisma espera "InputJsonValue" — fazemos o cast explícito
        payload: event.payload as object,
        version: nextVersion,
      },
    });
  }

  async loadEvents(aggregateId: string) {
    return this.prisma.event.findMany({
      where: { aggregateId },
      orderBy: { version: 'asc' },
    });
  }
}