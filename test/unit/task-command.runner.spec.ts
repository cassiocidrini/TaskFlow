/**
 * `TaskCommandRunner` — o roteiro único (Template Method) de todo comando de ciclo de vida.
 *
 * Cada um dos 5 passos (autorizar → carregar → regra → salvar → publicar) tem um teste que QUEBRA se o passo for
 * removido ou mudar de ordem. Destaques: o anti-IDOR (tarefa de outro projeto = o mesmo 404, e a mutação nem é
 * chamada), `TaskInvariantError` traduzido para 409 sem salvar nada, e bugs (ex.: `TypeError`) NÃO mascarados
 * como "conflito".
 *
 * Agregado novo a cada teste (`freshTask()`): ele é mutável — compartilhá-lo deixaria um teste contaminar o outro.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import { EventBus } from '@nestjs/cqrs';
import { TaskCommandRunner } from '../../src/modules/tasks/commands/task-command.runner';
import { TaskAggregate, TaskInvariantError } from '../../src/modules/tasks/domain/task.aggregate';
import { TaskRepository } from '../../src/modules/tasks/domain/task.repository';
import { ProjectsService } from '../../src/modules/projects/projects.service';
import { ConcurrencyConflictError } from '../../src/events/event-store.service';
import { TaskAssignedEvent, TaskStatusChangedEvent } from '../../src/modules/tasks/events/task.events';

describe('TaskCommandRunner (roteiro dos comandos de ciclo de vida)', () => {
  let runner: TaskCommandRunner;
  let projects: { assertOwner: jest.Mock };
  let repository: { load: jest.Mock; save: jest.Mock };
  let eventBus: { publish: jest.Mock };

  const target = { userId: 'u-dono', projectId: 'p1', taskId: 't1' };

  // Agregado novo a cada teste (é mutável — não pode ser compartilhado)
  const freshTask = (projectId = 'p1') =>
    TaskAggregate.fromHistory([
      { type: 'TaskCreated', data: { taskId: 't1', projectId, title: 'Tarefa', priority: 'MEDIUM' } },
    ]);

  beforeEach(() => {
    projects = { assertOwner: jest.fn().mockResolvedValue(undefined) };
    repository = {
      load: jest.fn().mockResolvedValue(freshTask()),
      // O save "real" devolve os eventos pendentes; o mock imita isso
      save: jest.fn().mockImplementation(async (task: TaskAggregate) => task.pullPendingEvents()),
    };
    eventBus = { publish: jest.fn() };

    runner = new TaskCommandRunner(
      projects as unknown as ProjectsService,
      repository as unknown as TaskRepository,
      eventBus as unknown as EventBus,
    );
  });

  // ============================================================
  // 1-2. Autorização e carregamento
  // ============================================================
  describe('autorização e carregamento', () => {
    it('deve verificar a posse do projeto ANTES de carregar a tarefa', async () => {
      projects.assertOwner.mockRejectedValue(new NotFoundException('Projeto não encontrado'));

      await expect(runner.run(target, (t) => t.assign('u1'))).rejects.toThrow(NotFoundException);
      expect(projects.assertOwner).toHaveBeenCalledWith('p1', 'u-dono');
      expect(repository.load).not.toHaveBeenCalled();
    });

    it('deve responder 404 quando a tarefa não existe', async () => {
      repository.load.mockResolvedValue(null);

      await expect(runner.run(target, (t) => t.assign('u1'))).rejects.toThrow('Tarefa não encontrada');
    });

    it('deve responder o MESMO 404 quando a tarefa é de OUTRO projeto (anti-IDOR)', async () => {
      repository.load.mockResolvedValue(freshTask('projeto-de-outra-pessoa'));
      const mutate = jest.fn();

      await expect(runner.run(target, mutate)).rejects.toThrow('Tarefa não encontrada');
      expect(mutate).not.toHaveBeenCalled(); // nem chega a tocar na tarefa alheia
      expect(repository.save).not.toHaveBeenCalled();
    });
  });

  // ============================================================
  // 3. Regra de domínio
  // ============================================================
  describe('regras de domínio', () => {
    it('deve traduzir TaskInvariantError (domínio) em 409 Conflict (HTTP), sem salvar nada', async () => {
      const mutate = () => {
        throw new TaskInvariantError('Não é possível concluir uma tarefa concluída');
      };

      const erro = await runner.run(target, mutate).catch((e: unknown) => e);

      expect(erro).toBeInstanceOf(ConflictException);
      expect((erro as ConflictException).message).toBe('Não é possível concluir uma tarefa concluída');
      expect(repository.save).not.toHaveBeenCalled();
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('NÃO deve mascarar erros que não são de domínio (bug continua sendo bug)', async () => {
      const mutate = () => {
        throw new TypeError('bug de programação');
      };

      await expect(runner.run(target, mutate)).rejects.toThrow(TypeError);
    });
  });

  // ============================================================
  // 4-5. Persistência e publicação
  // ============================================================
  describe('persistência e publicação', () => {
    it('deve salvar e publicar os eventos gravados, na ordem, como classes do barramento', async () => {
      await runner.run(target, (t) => {
        t.assign('u1');
        t.changeStatus('IN_PROGRESS');
      });

      expect(repository.save).toHaveBeenCalledTimes(1);
      const publicados = eventBus.publish.mock.calls.map(([e]) => e);
      expect(publicados).toHaveLength(2);
      expect(publicados[0]).toBeInstanceOf(TaskAssignedEvent);
      expect(publicados[1]).toBeInstanceOf(TaskStatusChangedEvent);
    });

    it('deve publicar SOMENTE depois de salvar', async () => {
      const ordem: string[] = [];
      repository.save.mockImplementation(async (task: TaskAggregate) => {
        ordem.push('save');
        return task.pullPendingEvents();
      });
      eventBus.publish.mockImplementation(() => ordem.push('publish'));

      await runner.run(target, (t) => t.assign('u1'));

      expect(ordem).toEqual(['save', 'publish']);
    });

    it('NÃO deve publicar nada se o save falhar por concorrência (409)', async () => {
      repository.save.mockRejectedValue(new ConcurrencyConflictError());

      await expect(runner.run(target, (t) => t.assign('u1'))).rejects.toThrow(ConcurrencyConflictError);
      expect(eventBus.publish).not.toHaveBeenCalled();
    });

    it('deve devolver o estado resumido da tarefa após o comando', async () => {
      const snapshot = await runner.run(target, (t) => t.complete(new Date('2026-10-18T12:00:00.000Z')));

      expect(snapshot).toEqual({
        taskId: 't1',
        status: 'DONE',
        assigneeId: undefined,
        completedAt: '2026-10-18T12:00:00.000Z',
      });
    });
  });
});
