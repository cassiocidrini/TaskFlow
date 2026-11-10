import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';
import type { ProjectStatsDto } from './dto/project-stats.response';

/**
 * Leitura dos relatórios por projeto (Módulo 13.6a). Só LÊ `project_stats`, que o consumer `reports` escreve.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * Números do projeto, só para o dono. `assertOwner` antes de ler: projeto alheio ou inexistente = 404, igual às
   * outras rotas do projeto (OWASP A01, anti-enumeração).
   *
   * Projeto sem linha em `project_stats` (nenhum evento processado ainda, ou criado agora) devolve zeros com
   * `asOf: null`, e não 404: o projeto existe, só não há o que contar, e o `asOf` diz isso ao cliente.
   */
  async statsFor(projectId: string, userId: string): Promise<ProjectStatsDto> {
    await this.projects.assertOwner(projectId, userId);
    const stats = await this.prisma.projectStats.findUnique({
      where: { projectId },
    });
    return {
      projectId,
      total: stats?.total ?? 0,
      byStatus: {
        pending: stats?.pending ?? 0,
        inProgress: stats?.inProgress ?? 0,
        done: stats?.done ?? 0,
      },
      unassignedOpen: stats?.unassignedOpen ?? 0,
      avgLeadTimeSeconds:
        stats && stats.done > 0
          ? Math.round(stats.leadTimeSecondsSum / stats.done)
          : null,
      asOf: stats?.lastEventAt?.toISOString() ?? null,
    };
  }
}
