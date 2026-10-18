import { Test, TestingModule } from '@nestjs/testing';
import { EventBus } from '@nestjs/cqrs';
import { CreateTaskHandler } from '../../src/modules/tasks/commands/create-task.handler';
import { CreateTaskCommand } from '../../src/modules/tasks/commands/create-task.command';
import { EventStoreService } from '../../src/events/event-store.service';
import { TaskCreatedEvent } from '../../src/modules/tasks/events/task.events';

describe('CreateTaskHandler', () => {
  let handler: CreateTaskHandler;
  let eventStore: { append: jest.Mock };
  let eventBus: { publish: jest.Mock };

  beforeEach(async () => {
    // Arrange: mocks
    eventStore = { append: jest.fn().mockResolvedValue(undefined) };
    eventBus = { publish: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CreateTaskHandler,
        { provide: EventStoreService, useValue: eventStore },
        { provide: EventBus, useValue: eventBus },
      ],
    }).compile();

    handler = module.get<CreateTaskHandler>(CreateTaskHandler);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('deve persistir um TaskCreated no Event Store', async () => {
    // Arrange
    const command = new CreateTaskCommand('p1', 'Minha tarefa', 'u1');

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
    });
  });

  it('deve publicar um TaskCreatedEvent no EventBus', async () => {
    // Arrange
    const command = new CreateTaskCommand('p1', 'Minha tarefa');

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
    const command = new CreateTaskCommand('p1', 'Tarefa');

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
    await handler.execute(new CreateTaskCommand('p1', 'Tarefa'));

    // Assert: a ordem correta é append → publish
    expect(ordem).toEqual(['append', 'publish']);
  });

  it('NÃO deve publicar no EventBus se o Event Store falhar', async () => {
    // Arrange
    eventStore.append.mockRejectedValue(new Error('DB fora do ar'));

    // Act + Assert
    await expect(
      handler.execute(new CreateTaskCommand('p1', 'Tarefa')),
    ).rejects.toThrow('DB fora do ar');

    expect(eventBus.publish).not.toHaveBeenCalled();
  });

  it('deve aceitar command sem assigneeId', async () => {
    // Arrange
    const command = new CreateTaskCommand('p1', 'Tarefa sem assignee');

    // Act
    const taskId = await handler.execute(command);

    // Assert
    const appendCall = eventStore.append.mock.calls[0][0];
    expect(appendCall.payload.assigneeId).toBeUndefined();
    expect(taskId).toBeDefined();
  });
});