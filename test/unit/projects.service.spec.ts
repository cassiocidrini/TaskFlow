/**
 * `ProjectsService` — a fechadura da autorização por projeto (OWASP A01).
 *
 * O teste mais importante NÃO é "lança 404": um mock devolvendo `null` passaria mesmo se alguém apagasse o filtro.
 * É "a query filtra por `id` E `ownerId`" — testar o que o código PEDE ao banco, não só o que ele devolve.
 * Também congela o `select` sem `ownerId` (API3) e a mesma mensagem para "inexistente" e "alheio" (anti-enumeração).
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { ProjectsService } from '../../src/modules/projects/projects.service';
import { PrismaService } from '../../src/prisma/prisma.service';

describe('ProjectsService', () => {
  let service: ProjectsService;
  let prisma: {
    project: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
    };
  };

  const ownerId = '11111111-1111-4111-8111-111111111111';
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const projectId = '33333333-3333-4333-8333-333333333333';

  const project = {
    id: projectId,
    name: 'TaskFlow',
    description: null,
    createdAt: new Date('2026-10-18T00:00:00Z'),
  };

  beforeEach(async () => {
    // Arrange: mock só dos métodos que o service usa
    prisma = {
      project: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProjectsService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(ProjectsService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // create
  // ============================================================
  describe('create', () => {
    it('deve gravar o projeto com o usuário autenticado como dono', async () => {
      prisma.project.create.mockResolvedValue(project);

      const result = await service.create(ownerId, { name: 'TaskFlow' });

      expect(prisma.project.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { name: 'TaskFlow', description: undefined, ownerId },
        }),
      );
      expect(result).toEqual(project);
    });

    it('NÃO deve expor ownerId na resposta (select explícito)', async () => {
      prisma.project.create.mockResolvedValue(project);

      await service.create(ownerId, { name: 'TaskFlow' });

      const { select } = prisma.project.create.mock.calls[0][0];
      expect(select).not.toHaveProperty('ownerId');
    });
  });

  // ============================================================
  // listByOwner
  // ============================================================
  describe('listByOwner', () => {
    it('deve listar SOMENTE os projetos do usuário', async () => {
      prisma.project.findMany.mockResolvedValue([project]);

      await service.listByOwner(ownerId);

      expect(prisma.project.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId } }),
      );
    });
  });

  // ============================================================
  // findOwned / assertOwner — a "fechadura" do sistema (OWASP A01)
  // ============================================================
  describe('findOwned / assertOwner', () => {
    it('deve filtrar por id E ownerId na MESMA query (o teste mais importante deste arquivo)', async () => {
      prisma.project.findFirst.mockResolvedValue(project);

      await service.findOwned(projectId, ownerId);

      expect(prisma.project.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: projectId, ownerId } }),
      );
    });

    it('deve retornar o projeto quando o usuário é o dono', async () => {
      prisma.project.findFirst.mockResolvedValue(project);

      await expect(service.findOwned(projectId, ownerId)).resolves.toEqual(project);
    });

    it('deve lançar NotFoundException quando o projeto não pertence ao usuário', async () => {
      // Para o banco, "projeto de outro usuário" e "projeto inexistente" são o mesmo resultado: null
      prisma.project.findFirst.mockResolvedValue(null);

      await expect(service.findOwned(projectId, otherUserId)).rejects.toThrow(NotFoundException);
    });

    it('assertOwner deve resolver sem retorno quando o usuário é o dono', async () => {
      prisma.project.findFirst.mockResolvedValue(project);

      await expect(service.assertOwner(projectId, ownerId)).resolves.toBeUndefined();
    });

    it('assertOwner deve rejeitar com a MESMA mensagem para inexistente e para alheio (anti-enumeration)', async () => {
      prisma.project.findFirst.mockResolvedValue(null);
      const erroAlheio = await service.assertOwner(projectId, otherUserId).catch((e: Error) => e.message);

      prisma.project.findFirst.mockResolvedValue(null);
      const erroInexistente = await service
        .assertOwner('44444444-4444-4444-8444-444444444444', ownerId)
        .catch((e: Error) => e.message);

      expect(erroAlheio).toBe('Projeto não encontrado');
      expect(erroAlheio).toBe(erroInexistente);
    });
  });
});
