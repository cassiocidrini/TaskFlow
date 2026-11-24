import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { TaskRead } from '@prisma/client';
import { GetTasksQuery } from './get-tasks.query';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectsService } from '../../projects/projects.service';
import type { CursorPage } from '../../../common/dto/pagination.dto';
import type { TaskDue } from '../events/task.events';
import type { ProjectStatsDto } from '../../reports/dto/project-stats.response';
import { ReportsService } from '../../reports/reports.service';

/**
 * Uma tarefa como a listagem a devolve. Mapeada campo a campo a partir da linha do Read Model, e não a linha crua:
 * colunas internas não podem vazar para o contrato só porque existem na tabela (Módulo 14.4: as colunas do prazo têm
 * nome e forma diferentes do campo `due` da resposta).
 */
export interface TaskListItem {
  id: string;
  projectId: string;
  title: string;
  status: TaskRead['status'];
  priority: TaskRead['priority'];
  assigneeId: string | null;
  due: TaskDue | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** O prazo vem de `due_at` + `due_timezone` (Módulo 14.4); `due_timezone` NULL = fuso desconhecido. */
export function toTaskListItem(row: TaskRead): TaskListItem {
  const at = row.dueAt;
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    due: at ? { at: at.toISOString(), timezone: row.dueTimezone } : null,
    completedAt: row.completedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A página da listagem; `stats` só com a flag `task-list-with-stats` ligada e só na primeira página (14.7). */
export type TaskListPage = CursorPage<TaskListItem> & { stats?: ProjectStatsDto };

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
    private readonly reports: ReportsService,
  ) {}

  async execute(query: GetTasksQuery): Promise<TaskListPage> {
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
      items: items.map(toTaskListItem),
      nextCursor: hasNextPage ? items[items.length - 1].id : null,
      // Flag `task-list-with-stats` (14.7): só na PRIMEIRA página. O app pede o resumo uma vez; repetir a consulta a
      // cada página de rolagem seria pagar o custo à toa. O `assertOwner` acima já autorizou o projeto
      ...(query.includeStats && !query.cursor
        ? { stats: await this.reports.statsOf(query.projectId) }
        : {}),
    };
  }
}
