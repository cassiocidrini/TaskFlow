import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { TaskRead } from '@prisma/client';
import { GetTasksQuery } from './get-tasks.query';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectsService } from '../../projects/projects.service';
import type { CursorPage } from '../../../common/dto/pagination.dto';
import type { TaskDue } from '../events/task.events';

/**
 * Uma tarefa como a listagem a devolve. Mapeada campo a campo a partir da linha do Read Model, e não a linha crua:
 * colunas internas (como a `due_date`, que não é mais usada desde a 14.4b e sai do banco na 14.4c) não podem vazar
 * para o contrato só porque existem na tabela.
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

/**
 * Lê só as colunas novas do prazo (`due_at`, `due_timezone`). A reserva `due_at ?? due_date` do expand saiu no contract
 * (14.4b), depois do backfill final, que cobre as linhas criadas pela versão anterior no meio do deploy da 14.4a.
 */
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

  async execute(query: GetTasksQuery): Promise<CursorPage<TaskListItem>> {
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
    };
  }
}
