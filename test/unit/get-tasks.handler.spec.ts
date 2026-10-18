/**
 * `GetTasksHandler` — leitura do Read Model com paginação por cursor.
 *
 * Protege: autorização antes de ler (uma leitura alheia também é A01), o truque `take: limit + 1` (saber se há
 * próxima página sem `COUNT(*)`), a ordenação estável com `id` como desempate e que o item extra NÃO vaza na resposta.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { GetTasksHandler } from '../../src/modules/tasks/queries/get-tasks.handler';
import { GetTasksQuery } from '../../src/modules/tasks/queries/get-tasks.query';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ProjectsService } from '../../src/modules/projects/projects.service';

describe('GetTasksHandler', () => {
  let handler: GetTasksHandler;
  let prisma: { taskRead: { findMany: jest.Mock } };
  let projects: { assertOwner: jest.Mock };

  const userId = 'user-dono';
  const projectId = 'p1';

  // Gera N linhas falsas do read model com ids previsíveis: t1, t2, ...
  const fakeRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `t${i + 1}`, projectId, title: `Tarefa ${i + 1}` }));

  beforeEach(async () => {
    // Arrange: por padrão, o usuário É dono do projeto
    prisma = { taskRead: { findMany: jest.fn().mockResolvedValue([]) } };
    projects = { assertOwner: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GetTasksHandler,
        { provide: PrismaService, useValue: prisma },
        { provide: ProjectsService, useValue: projects },
      ],
    }).compile();

    handler = module.get(GetTasksHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ============================================================
  // Autorização (OWASP A01)
  // ============================================================
  describe('autorização', () => {
    it('deve verificar a posse do projeto com o userId da query', async () => {
      await handler.execute(new GetTasksQuery(userId, projectId, 20));

      expect(projects.assertOwner).toHaveBeenCalledWith(projectId, userId);
    });

    it('NÃO deve consultar o read model se o projeto não for do usuário', async () => {
      projects.assertOwner.mockRejectedValue(new NotFoundException('Projeto não encontrado'));

      await expect(handler.execute(new GetTasksQuery('intruso', projectId, 20))).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.taskRead.findMany).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // Paginação por cursor
  // ============================================================
  describe('paginação', () => {
    it('deve pedir limit + 1 linhas, filtrar pelo projeto e ordenar de forma estável', async () => {
      await handler.execute(new GetTasksQuery(userId, projectId, 20));

      expect(prisma.taskRead.findMany).toHaveBeenCalledWith({
        where: { projectId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      });
    });

    it('deve retornar nextCursor = id do último item quando há mais páginas', async () => {
      prisma.taskRead.findMany.mockResolvedValue(fakeRows(3)); // limit 2 + 1 extra

      const page = await handler.execute(new GetTasksQuery(userId, projectId, 2));

      expect(page.items.map((t) => t.id)).toEqual(['t1', 't2']); // o extra NÃO vaza na resposta
      expect(page.nextCursor).toBe('t2');
    });

    it('deve retornar nextCursor = null na última página', async () => {
      prisma.taskRead.findMany.mockResolvedValue(fakeRows(2));

      const page = await handler.execute(new GetTasksQuery(userId, projectId, 2));

      expect(page.items).toHaveLength(2);
      expect(page.nextCursor).toBeNull();
    });

    it('deve continuar a partir do cursor, pulando o próprio item do cursor', async () => {
      await handler.execute(new GetTasksQuery(userId, projectId, 20, 't2'));

      expect(prisma.taskRead.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ cursor: { id: 't2' }, skip: 1 }),
      );
    });

    it('deve retornar página vazia sem cursor quando o projeto não tem tarefas', async () => {
      const page = await handler.execute(new GetTasksQuery(userId, projectId, 20));

      expect(page).toEqual({ items: [], nextCursor: null });
    });
  });
});
