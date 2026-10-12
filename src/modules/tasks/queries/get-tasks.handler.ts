import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { GetTasksQuery } from './get-tasks.query';
import { PrismaService } from '../../prisma/prisma.service';

@QueryHandler(GetTasksQuery)
export class GetTasksHandler implements IQueryHandler<GetTasksQuery> {
  constructor(private readonly prisma: PrismaService) {}

  async execute(query: GetTasksQuery) {
    // Lê DIRETO da projeção — rápido, sem JOINs, sem recomputar
    return this.prisma.taskRead.findMany({
      where: { projectId: query.projectId },
      orderBy: { createdAt: 'desc' },
    });
  }
}