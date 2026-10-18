import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { TaskRead } from '@prisma/client';
import { GetTasksQuery } from './get-tasks.query';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectsService } from '../../projects/projects.service';
import type { CursorPage } from '../../../common/dto/pagination.dto';

@QueryHandler(GetTasksQuery)
export class GetTasksHandler implements IQueryHandler<GetTasksQuery> {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  async execute(query: GetTasksQuery): Promise<CursorPage<TaskRead>> {
    // Autorização primeiro: 404 se o projeto não for do usuário
    await this.projects.assertOwner(query.projectId, query.userId);

    // Lê DIRETO da projeção — rápido, sem JOINs, sem recomputar.
    // Pede 1 item a mais para saber se existe próxima página sem fazer COUNT(*).
    const rows = await this.prisma.taskRead.findMany({
      where: { projectId: query.projectId },
      // id como desempate: duas tarefas no mesmo milissegundo ainda têm ordem estável
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
      ...(query.cursor && { cursor: { id: query.cursor }, skip: 1 }), // skip: 1 pula o próprio cursor
    });

    const hasNextPage = rows.length > query.limit;
    const items = hasNextPage ? rows.slice(0, query.limit) : rows;

    return {
      items,
      nextCursor: hasNextPage ? items[items.length - 1].id : null,
    };
  }
}
