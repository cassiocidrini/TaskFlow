import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProjectDto } from './dto/create-project.dto';

/**
 * Campos expostos pela API (`select` explícito).
 *
 * Por que não devolver a linha inteira? Porque uma coluna sensível adicionada amanhã vazaria
 * automaticamente. Com `select`, só sai o que foi escolhido (OWASP API3). O `as const` preserva os
 * literais `true`, e o Prisma infere o tipo EXATO do retorno.
 */
const projectSelect = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
} as const;

/**
 * Projetos e, principalmente, o PONTO ÚNICO de autorização por projeto ({@link assertOwner}).
 *
 * CRUD simples, em estilo Layered (service → Prisma), sem CQRS nem Event Sourcing — de propósito:
 * um projeto não tem histórico relevante. Aplicar Event Sourcing em tudo seria o anti-pattern
 * *golden hammer*; ele fica onde agrega valor (tarefas).
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /** @param ownerId sempre o usuário do JWT — nunca um valor vindo do cliente (OWASP A01). */
  create(ownerId: string, dto: CreateProjectDto) {
    return this.prisma.project.create({
      data: { name: dto.name, description: dto.description, ownerId },
      select: projectSelect,
    });
  }

  /** Lista só os projetos do usuário; o índice `@@index([ownerId])` mantém a consulta barata. */
  listByOwner(ownerId: string) {
    return this.prisma.project.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      select: projectSelect,
    });
  }

  /**
   * Busca um projeto **do usuário**, filtrando por `id` E `ownerId` na MESMA consulta.
   *
   * A alternativa ingênua ("busca pelo id, depois compara o dono em JavaScript") tem dois defeitos: duas
   * respostas diferentes (404 × 403) que confirmam a existência de projetos alheios, e mais lógica onde
   * um esquecimento abre brecha. Aqui o banco responde a pergunta inteira.
   *
   * @throws NotFoundException (404) para "não existe" E para "existe, mas é de outro usuário".
   */
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
   * Ponto ÚNICO de autorização por projeto (OWASP A01 — Broken Access Control).
   *
   * Chamado pelos handlers de tarefas ANTES de qualquer efeito colateral — em especial antes do `append`
   * no Event Store, que é append-only: um evento gravado indevidamente nunca mais sai.
   *
   * Responde 404 (e não 403) para recurso alheio: a API não confirma a existência de projetos de outros
   * usuários (anti-enumeração), o mesmo comportamento de GitHub e S3. Se a política mudar (ex.: membros
   * além do dono), muda aqui, em um lugar só.
   */
  async assertOwner(projectId: string, userId: string): Promise<void> {
    await this.findOwned(projectId, userId);
  }
}
