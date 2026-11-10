/**
 * Contrato PÚBLICO dos eventos de tarefa (`taskflow.task-events.v1`) — Módulo 13.2.
 *
 * Protege o que os consumers de outros serviços enxergam:
 * - o envelope completo (identidade, versão do contrato, ordem, `projectId`, autor, correlação);
 * - o `data` de cada tipo, CAMPO A CAMPO: um campo interno do evento de domínio não pode vazar para o tópico,
 *   e `taskId` não se repete (é o `aggregateId`);
 * - opcionais ausentes ficam ausentes (não viram `undefined`/`null` no JSON);
 * - a mensagem da outbox: tópico do contrato e chave = `taskId` (ordem por tarefa no Kafka).
 *
 * Função pura: sem banco, sem relógio, sem Nest. O efeito transacional está em `test/integration/outbox.spec.ts`.
 */
import type { TaskDomainEvent } from '../../src/modules/tasks/events/task.events';
import {
  TASK_EVENTS_TOPIC,
  toTaskIntegrationEvent,
  toTaskOutboxMessage,
} from '../../src/modules/tasks/events/task.integration-events';

describe('Eventos de integração da tarefa', () => {
  const recorded = {
    metadata: {
      eventId: 'ev-1',
      actorId: 'user-1',
      correlationId: 'corr-1',
      schemaVersion: 1,
    },
    aggregateVersion: 3,
    recordedAt: new Date('2026-11-10T12:00:00.000Z'),
  };

  const envelope = {
    eventId: 'ev-1',
    eventVersion: 1,
    occurredAt: '2026-11-10T12:00:00.000Z',
    aggregateId: 't1',
    aggregateVersion: 3,
    projectId: 'p1',
    actorId: 'user-1',
    correlationId: 'corr-1',
  };

  it.each<[string, TaskDomainEvent, Record<string, unknown>]>([
    [
      'TaskCreated',
      {
        type: 'TaskCreated',
        data: {
          taskId: 't1',
          projectId: 'p1',
          title: 'Pagar boleto',
          priority: 'HIGH',
          assigneeId: 'u2',
          dueDate: '2026-11-20T00:00:00.000Z',
        },
      },
      {
        title: 'Pagar boleto',
        priority: 'HIGH',
        assigneeId: 'u2',
        dueDate: '2026-11-20T00:00:00.000Z',
      },
    ],
    [
      'TaskAssigned',
      { type: 'TaskAssigned', data: { taskId: 't1', assigneeId: 'u2' } },
      { assigneeId: 'u2' },
    ],
    [
      'TaskStatusChanged',
      {
        type: 'TaskStatusChanged',
        data: { taskId: 't1', from: 'PENDING', to: 'IN_PROGRESS' },
      },
      { from: 'PENDING', to: 'IN_PROGRESS' },
    ],
    [
      'TaskCompleted',
      {
        type: 'TaskCompleted',
        data: { taskId: 't1', completedAt: '2026-11-10T11:59:00.000Z' },
      },
      { completedAt: '2026-11-10T11:59:00.000Z' },
    ],
  ])(
    'deve mapear %s para o envelope completo e o data do contrato',
    (eventType, event, data) => {
      expect(toTaskIntegrationEvent(event, recorded, 'p1')).toEqual({
        ...envelope,
        eventType,
        data,
      });
    },
  );

  it('NÃO deve vazar para o tópico um campo do domínio que não está no contrato', () => {
    // Simula um campo interno adicionado ao evento de domínio no futuro, sem atualizar o contrato
    const event = {
      type: 'TaskAssigned',
      data: { taskId: 't1', assigneeId: 'u2', internalScore: 42 },
    } as unknown as TaskDomainEvent;

    const integration = toTaskIntegrationEvent(event, recorded, 'p1');

    expect(integration.data).toEqual({ assigneeId: 'u2' });
    expect(JSON.stringify(integration)).not.toContain('internalScore');
  });

  it('deve omitir opcionais ausentes (assigneeId, dueDate, correlationId) em vez de serializar undefined', () => {
    const integration = toTaskIntegrationEvent(
      {
        type: 'TaskCreated',
        data: {
          taskId: 't1',
          projectId: 'p1',
          title: 'Sem prazo',
          priority: 'LOW',
        },
      },
      {
        ...recorded,
        metadata: { eventId: 'ev-2', actorId: 'user-1', schemaVersion: 1 },
      },
      'p1',
    );

    expect(integration).not.toHaveProperty('correlationId');
    expect(integration.data).toEqual({ title: 'Sem prazo', priority: 'LOW' });
    expect(Object.keys(integration.data)).toEqual(['title', 'priority']);
  });

  it('deve embrulhar na mensagem da outbox com o tópico do contrato e chave = taskId', () => {
    const message = toTaskOutboxMessage(
      {
        type: 'TaskCompleted',
        data: { taskId: 't1', completedAt: '2026-11-10T11:59:00.000Z' },
      },
      recorded,
      'p1',
    );

    expect(message).toEqual({
      topic: TASK_EVENTS_TOPIC,
      key: 't1',
      eventType: 'TaskCompleted',
      payload: {
        ...envelope,
        eventType: 'TaskCompleted',
        data: { completedAt: '2026-11-10T11:59:00.000Z' },
      },
    });
    expect(TASK_EVENTS_TOPIC).toBe('taskflow.task-events.v1'); // o mesmo tópico que o kafka-init cria
  });
});
