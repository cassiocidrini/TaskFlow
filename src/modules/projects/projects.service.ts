import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';

// Campos expostos na API (ownerId fica de fora: é sempre o próprio usuário)
const projectSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
} as const;

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  create(ownerId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: { name: dto.name, description: dto.description, ownerId },
      select: projectSelect,
    });
  }

  listByOwner(ownerId: string) {
    return this.prisma.project.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: projectSelect,
    });
  }

  async findOwned(projectId: string, userId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId: userId },
      select: projectSelect,
    });

    if (!project) {
      throw new NotFoundException('Projeto não encontrado');
    }

    return project;
  }

  /**
   * Ponto ÚNICO de autorização por projeto (OWASP A01).
   *
   * Responde 404 tanto para "não existe" quanto para "existe, mas é de outro usuário":
   * assim a API não confirma a existência de recursos alheios (anti-enumeration).
   */
  async assertOwner(projectId: string, userId: string): Promise<void> {
    await this.findOwned(projectId, userId);
  }
}
