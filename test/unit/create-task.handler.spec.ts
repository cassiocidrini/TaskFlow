/**
 * `CreateTaskHandler` — o nascimento de um agregado event-sourced.
 *
 * Protege a ORDEM, que aqui é regra de negócio: `assertOwner → append → publish`. Autorização antes de qualquer
 * efeito (o Event Store é append-only: um evento indevido nunca mais sai — OWASP A01) e publicação só depois de
 * persistir. Também prova: zero efeitos quando o projeto não é do usuário, evento GRAVADO = evento PUBLICADO
 * (eram montados separadamente e divergiam) e a prioridade/prazo atravessando o fluxo.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { CreateTaskHandler } from '../../src/modules/tasks/commands/create-task.handler';
import { CreateTaskCommand } from '../../src/modules/tasks/commands/create-task.command';
import { EventStoreService } from '../../src/events/event-store.service';
import { TaskCreatedEvent } from '../../src/modules/tasks/events/task.events';
import { ProjectsService } from '../../src/modules/projects/projects.service';

describe('CreateTaskHandler', () => {
  let handler: CreateTaskHandler;
  let eventStore: { append: jest.Mock };
  let eventBus: { publish: jest.Mock };
  let projects: { assertOwner: jest.Mock };

  const userId = 'user-dono';

  beforeEach(async () => {
    // Arrange: mocks (por padrão, o usuário É dono do projeto)
    eventStore = { append: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };
    projects = { assertOwner: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateTaskHandler,
        { provide: EventStoreService, useValue: eventStore },
        { provide: EventBus, useValue: eventBus },
        { provide: ProjectsService, useValue: projects },
      ],
    }).compile();

    handler = module.get<CreateTaskHandler>(CreateTaskHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('deve persistir um TaskCreated no Event Store', async () => {
    // Arrange
    const command = new CreateTaskCommand(userId, 'p1', 'Minha tarefa', 'u1');

    // Act
    const taskId = await handler.execute(command);

    // Assert
    expect(eventStore.append).toHaveBeenCalledTimes(1);
    expect(eventStore.append).toHaveBeenCalledWith({
      aggregateId: taskId,
      aggregateType: 'Task',
      eventType: 'TaskCreated',
      payload: {
        taskId,
        projectId: 'p1',
        title: 'Minha tarefa',
        assigneeId: 'u1',
        priority: 'MEDIUM',
      },
    }, 0); // versão esperada 0: agregado novo
  });

  it('deve publicar um TaskCreatedEvent no EventBus', async () => {
    // Arrange
    const command = new CreateTaskCommand(userId, 'p1', 'Minha tarefa');

    // Act
    const taskId = await handler.execute(command);

    // Assert
    expect(eventBus.publish).toHaveBeenCalledTimes(1);
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.any(TaskCreatedEvent),
    );

    const publishedEvent = eventBus.publish.mock.calls[0][0] as TaskCreatedEvent;
    expect(publishedEvent.taskId).toBe(taskId);
    expect(publishedEvent.projectId).toBe('p1');
    expect(publishedEvent.title).toBe('Minha tarefa');
  });

  it('deve gerar um taskId (UUID) único', async () => {
    // Arrange
    const command = new CreateTaskCommand(userId, 'p1', 'Tarefa');

    // Act
    const taskId1 = await handler.execute(command);
    const taskId2 = await handler.execute(command);

    // Assert
    expect(taskId1).not.toBe(taskId2);
    expect(taskId1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('deve persistir o evento ANTES de publicar no EventBus', async () => {
    // Arrange
    const ordem: string[] = [];
    eventStore.append.mockImplementation(async () => {
      ordem.push('append');
    });
    eventBus.publish.mockImplementation(() => {
      ordem.push('publish');
    });

    // Act
    await handler.execute(new CreateTaskCommand(userId, 'p1', 'Tarefa'));

    // Assert: a ordem correta é append → publish
    expect(ordem).toEqual(['append', 'publish']);
  });

  it('NÃO deve publicar no EventBus se o Event Store falhar', async () => {
    // Arrange
    eventStore.append.mockRejectedValue(new Error('DB fora do ar'));

    // Act + Assert
    await expect(
      handler.execute(new CreateTaskCommand(userId, 'p1', 'Tarefa')),
    ).rejects.toThrow('DB fora do ar');

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('deve aceitar command sem assigneeId', async () => {
    // Arrange
    const command = new CreateTaskCommand(userId, 'p1', 'Tarefa sem assignee');

    // Act
    const taskId = await handler.execute(command);

    // Assert
    const appendCall = eventStore.append.mock.calls[0][0];
    expect(appendCall.payload.assigneeId).toBeUndefined();
    expect(taskId).toBeDefined();
  });

  // ============================================================
  // Prioridade e prazo atravessando o fluxo (antes eram descartados)
  // ============================================================
  describe('priority e dueDate', () => {
    const dueDate = new Date('2026-12-31T23:59:59.000Z');

    it('deve gravar o dueDate (ISO) no payload do Event Store', async () => {
      await handler.execute(new CreateTaskCommand(userId, 'p1', 'Tarefa', undefined, dueDate));

      const [stored] = eventStore.append.mock.calls[0];
      expect(stored.payload.dueDate).toBe('2026-12-31T23:59:59.000Z');
    });

    it('deve publicar priority e dueDate no TaskCreatedEvent (chegam ao Read Model)', async () => {
      await handler.execute(new CreateTaskCommand(userId, 'p1', 'Corrigir bug urgente', undefined, dueDate));

      const published = eventBus.publish.mock.calls[0][0] as TaskCreatedEvent;
      expect(published.priority).toBe('HIGH'); // "bug" e "urgente" → KeywordPriorityStrategy
      expect(published.dueDate).toBe('2026-12-31T23:59:59.000Z');
    });

    it('evento GRAVADO e evento PUBLICADO devem carregar exatamente os mesmos dados', async () => {
      await handler.execute(new CreateTaskCommand(userId, 'p1', 'Tarefa', 'u1', dueDate));

      const [stored] = eventStore.append.mock.calls[0];
      const published = eventBus.publish.mock.calls[0][0] as TaskCreatedEvent;
      // toEqual compara só as propriedades (ignora o prototype da classe), então não precisa de spread
      expect(published).toEqual(stored.payload);
    });
  });

  // ============================================================
  // Autorização (OWASP A01)
  // ============================================================
  describe('autorização', () => {
    it('deve verificar a posse do projeto com o userId do command', async () => {
      await handler.execute(new CreateTaskCommand(userId, 'p1', 'Tarefa'));

      expect(projects.assertOwner).toHaveBeenCalledWith('p1', userId);
    });

    it('deve verificar a posse ANTES de gravar no Event Store (append-only!)', async () => {
      const ordem: string[] = [];
      projects.assertOwner.mockImplementation(async () => {
        ordem.push('assertOwner');
      });
      eventStore.append.mockImplementation(async () => {
        ordem.push('append');
      });

      await handler.execute(new CreateTaskCommand(userId, 'p1', 'Tarefa'));

      expect(ordem).toEqual(['assertOwner', 'append']);
    });

    it('NÃO deve gravar nem publicar nada se o projeto não for do usuário', async () => {
      projects.assertOwner.mockRejectedValue(new NotFoundException('Projeto não encontrado'));

      await expect(
        handler.execute(new CreateTaskCommand('intruso', 'p1', 'Tarefa')),
      ).rejects.toThrow(NotFoundException);

      expect(eventStore.append).not.toHaveBeenCalled();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });
  });
});