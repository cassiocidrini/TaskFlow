/**
 * Tarefas via HTTP com DOIS usuários — o dono e um intruso.
 *
 * É aqui que as peças provam que ENCAIXAM (guard esquecido, módulo não importado, migração × código):
 * - Segurança: 401 sem token · 400 UUID inválido · intruso recebe 404 E ZERO eventos são gravados ·
 *   anti-IDOR entre dois projetos do MESMO dono (o caso mais sutil: o `assertOwner` passaria).
 * - CQRS: a tarefa aparece no Read Model — via `eventually()`, porque a projeção roda depois da resposta.
 * - Paginação "sem repetição nem buracos" e ciclo de vida completo, com 409 em tarefa concluída.
 *
 * Testes com consistência eventual: rode 3 vezes antes de confiar.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  E2EContext,
  TestUser,
  eventually,
  registerAndLogin,
  resetDatabase,
  startE2EApp,
} from './support/e2e-app';

describe('Tasks (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  let owner: TestUser;
  let intruder: TestUser;
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const tasksUrl = (pid = projectId) => `/projects/${pid}/tasks`;

  const createProject = async (user: TestUser, name = 'Projeto E2E'): Promise<string> => {
    const res = await http().post('/projects').set(user.auth).send({ name }).expect(201);
    return res.body.id as string;
  };

  const createTask = async (body: Record<string, unknown> = { title: 'Tarefa E2E' }, pid = projectId) => {
    const res = await http().post(tasksUrl(pid)).set(owner.auth).send(body).expect(201);
    return res.body.taskId as string;
  };

  /** Lê a tarefa pelo Read Model (GET paginado) — sujeito à consistência eventual */
  const findInReadModel = async (taskId: string, pid = projectId) => {
    const res = await http().get(`${tasksUrl(pid)}?limit=100`).set(owner.auth).expect(200);
    return (res.body.items as Array<Record<string, unknown>>).find((t) => t.id === taskId);
  };

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    owner = await registerAndLogin(app, 'Dono');
    intruder = await registerAndLogin(app, 'Intruso');
    projectId = await createProject(owner);
  });

  // ============================================================
  // Segurança (OWASP A01) — o furo nº 1 da análise, agora provado fechado
  // ============================================================
  describe('segurança', () => {
    it('deve exigir token: 401 sem Authorization em criar e listar', async () => {
      await http().post(tasksUrl()).send({ title: 'Sem token' }).expect(401);
      await http().get(tasksUrl()).expect(401);
    });

    it('deve validar o projectId da URL: 400 para UUID inválido', async () => {
      await http().get(tasksUrl('nao-e-uuid')).set(owner.auth).expect(400);
    });

    it('intruso NÃO deve listar tarefas do projeto alheio (404, não 403)', async () => {
      await http().get(tasksUrl()).set(intruder.auth).expect(404);
    });

    it('intruso NÃO deve criar tarefa no projeto alheio — e nenhum evento é gravado', async () => {
      await http().post(tasksUrl()).set(intruder.auth).send({ title: 'Invasão' }).expect(404);

      expect(await ctx.prisma.event.count()).toBe(0); // append-only: nada indevido entrou
    });

    it('intruso NÃO deve ler o histórico de tarefa alheia', async () => {
      const taskId = await createTask();

      await http().get(`${tasksUrl()}/${taskId}/history`).set(intruder.auth).expect(404);
    });

    it('anti-IDOR: tarefa do projeto A não pode ser alterada pela URL do projeto B (mesmo sendo dono de ambos)', async () => {
      const taskId = await createTask();
      const outroProjeto = await createProject(owner, 'Outro projeto do mesmo dono');

      await http()
        .patch(`${tasksUrl(outroProjeto)}/${taskId}/status`)
        .set(owner.auth)
        .send({ status: 'IN_PROGRESS' })
        .expect(404);
    });
  });

  // ============================================================
  // Criação e leitura (CQRS: escrita no Event Store → projeção → Read Model)
  // ============================================================
  describe('criação e leitura', () => {
    it('tarefa criada deve aparecer no GET com prioridade calculada e prazo (consistência eventual)', async () => {
      const taskId = await createTask({ title: 'Bug urgente no login', dueDate: '2026-12-31T23:59:59.000Z' });

      // A projeção roda DEPOIS da resposta 201 — por isso "eventually", e não uma leitura imediata
      await eventually(async () => {
        expect(await findInReadModel(taskId)).toMatchObject({
          title: 'Bug urgente no login',
          status: 'PENDING',
          priority: 'HIGH', // "bug" e "urgente" → KeywordPriorityStrategy
          dueDate: '2026-12-31T23:59:59.000Z',
        });
      });
    });

    it.each([
      ['título curto demais', { title: 'ab' }],
      ['campo extra (mass assignment)', { title: 'Tarefa válida', ownerId: 'hacker' }],
      ['dueDate inválido', { title: 'Tarefa válida', dueDate: 'amanhã' }],
    ])('deve rejeitar body inválido com 400: %s', async (_caso, body) => {
      await http().post(tasksUrl()).set(owner.auth).send(body).expect(400);
    });

    it('deve paginar por cursor: páginas sem repetição nem buracos', async () => {
      const ids = [await createTask({ title: 'Tarefa 1' }), await createTask({ title: 'Tarefa 2' }), await createTask({ title: 'Tarefa 3' })];
      await eventually(async () => {
        const res = await http().get(`${tasksUrl()}?limit=100`).set(owner.auth).expect(200);
        expect(res.body.items).toHaveLength(3);
      });

      const pagina1 = await http().get(`${tasksUrl()}?limit=2`).set(owner.auth).expect(200);
      expect(pagina1.body.items).toHaveLength(2);
      expect(pagina1.body.nextCursor).toEqual(expect.any(String));

      const pagina2 = await http()
        .get(`${tasksUrl()}?limit=2&cursor=${pagina1.body.nextCursor}`)
        .set(owner.auth)
        .expect(200);
      expect(pagina2.body.items).toHaveLength(1);
      expect(pagina2.body.nextCursor).toBeNull();

      const vistos = [...pagina1.body.items, ...pagina2.body.items].map((t: { id: string }) => t.id);
      expect(new Set(vistos)).toEqual(new Set(ids));
    });

    it('deve impor o teto de paginação: 400 para limit acima de 100', async () => {
      await http().get(`${tasksUrl()}?limit=500`).set(owner.auth).expect(400);
    });
  });

  // ============================================================
  // Ciclo de vida (Event Sourcing)
  // ============================================================
  describe('ciclo de vida', () => {
    it('atribuir → iniciar → concluir: snapshots corretos e Read Model sincronizado', async () => {
      const taskId = await createTask();
      const taskUrl = `${tasksUrl()}/${taskId}`;

      const assigned = await http().patch(`${taskUrl}/assignee`).set(owner.auth).send({ assigneeId: owner.userId }).expect(200);
      expect(assigned.body).toMatchObject({ status: 'PENDING', assigneeId: owner.userId });

      const started = await http().patch(`${taskUrl}/status`).set(owner.auth).send({ status: 'IN_PROGRESS' }).expect(200);
      expect(started.body.status).toBe('IN_PROGRESS');

      const completed = await http().post(`${taskUrl}/complete`).set(owner.auth).expect(200);
      expect(completed.body).toMatchObject({ status: 'DONE', completedAt: expect.any(String) });

      await eventually(async () => {
        expect(await findInReadModel(taskId)).toMatchObject({
          status: 'DONE',
          assigneeId: owner.userId,
          completedAt: completed.body.completedAt,
        });
      });
    });

    it('tarefa concluída é imutável: 409 ao concluir de novo ou reatribuir', async () => {
      const taskId = await createTask();
      const taskUrl = `${tasksUrl()}/${taskId}`;
      await http().post(`${taskUrl}/complete`).set(owner.auth).expect(200);

      await http().post(`${taskUrl}/complete`).set(owner.auth).expect(409);
      await http().patch(`${taskUrl}/assignee`).set(owner.auth).send({ assigneeId: owner.userId }).expect(409);
    });

    it('PATCH /status não aceita DONE (concluir tem rota própria): 400', async () => {
      const taskId = await createTask();

      await http().patch(`${tasksUrl()}/${taskId}/status`).set(owner.auth).send({ status: 'DONE' }).expect(400);
    });

    it('404 ao operar tarefa inexistente', async () => {
      await http()
        .post(`${tasksUrl()}/11111111-1111-4111-8111-111111111111/complete`)
        .set(owner.auth)
        .expect(404);
    });

    it('histórico: linha do tempo completa e estado reconstruído dos eventos', async () => {
      const taskId = await createTask({ title: 'Corrigir bug crítico' });
      const taskUrl = `${tasksUrl()}/${taskId}`;
      await http().patch(`${taskUrl}/assignee`).set(owner.auth).send({ assigneeId: owner.userId }).expect(200);
      await http().patch(`${taskUrl}/status`).set(owner.auth).send({ status: 'IN_PROGRESS' }).expect(200);
      await http().post(`${taskUrl}/complete`).set(owner.auth).expect(200);

      const res = await http().get(`${taskUrl}/history`).set(owner.auth).expect(200);

      expect(res.body.history.map((h: { version: number; type: string }) => [h.version, h.type])).toEqual([
        [1, 'TaskCreated'],
        [2, 'TaskAssigned'],
        [3, 'TaskStatusChanged'],
        [4, 'TaskCompleted'],
      ]);
      expect(res.body.history[2].data).toMatchObject({ from: 'PENDING', to: 'IN_PROGRESS' });
      expect(res.body.current).toMatchObject({
        title: 'Corrigir bug crítico',
        status: 'DONE',
        priority: 'HIGH',
        assigneeId: owner.userId,
        version: 4,
      });
    });
  });
});
