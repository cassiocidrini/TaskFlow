import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import type { TaskRead } from '@prisma/client';
import { GetTasksQuery } from './get-tasks.query';
import { PrismaService } from '../../../prisma/prisma.service';
import { ProjectsService } from '../../projects/projects.service';
import type { CursorPage } from '../../../common/dto/pagination.dto';
import type { TaskDue } from '../events/task.events';

/**
 * Uma tarefa como a listagem a devolve. Mapeada campo a campo a partir da linha do Read Model, e não a linha crua:
 * colunas internas (as do expand/contract do Módulo 14.4: `due_at`, `due_timezone`, `due_date`) não podem vazar para
 * o contrato só porque existem na tabela.
 */
export interface TaskListItem {
  id: string;
  projectId: string;
  title: string;
  status: TaskRead['status'];
  priority: TaskRead['priority'];
  assigneeId: string | null;
  /** Depreciado (Módulo 14.4): o mesmo instante de `due.at`, para o app que ainda não migrou. */
  dueDate: Date | null;
  due: TaskDue | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Durante o expand, `due_at ?? due_date`: uma linha criada pela versão anterior da API no meio do deploy (depois do
 * backfill) só tem a coluna antiga, e continua aparecendo certa. Sai no contract (14.4b), junto com a coluna.
 */
export function toTaskListItem(row: TaskRead): TaskListItem {
  const at = row.dueAt ?? row.dueDate;
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assigneeId,
    dueDate: at,
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
