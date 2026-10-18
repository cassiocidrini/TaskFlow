import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { TaskRead } from '@prisma/client';
import { GetTasksQuery } from './get-tasks.query';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectsService } from '../../projects/projects.service';
import type { CursorPage } from '../../../common/dto/pagination.dto';

/**
 * Lado de LEITURA do CQRS: lista as tarefas a partir do Read Model `tasks_read`.
 *
 * Por que não reconstruir cada tarefa a partir dos eventos? Porque listar N tarefas exigiria ler e aplicar
 * TODOS os eventos de cada uma. O Read Model é uma projeção desnormalizada, já no formato da resposta:
 * uma única consulta indexada (`@@index([projectId, createdAt])`), sem JOINs nem recomputação.
 *
 * O preço é a **consistência eventual**: uma tarefa recém-criada aparece aqui só depois que a projeção roda
 * (normalmente milissegundos). Para ler o estado exato de UMA tarefa, o histórico consulta o Event Store.
 */
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
