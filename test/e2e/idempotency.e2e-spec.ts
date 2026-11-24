/**
 * `Idempotency-Key` no `POST /tasks` via HTTP, com a MESMA configuração da produção (`configureApp`) — Módulo 14.5.
 *
 * Protege o contrato que o app usa quando a rede falha e ele repete a requisição:
 * - a nova tentativa com a mesma chave responde 201 com o MESMO `taskId` e `Idempotent-Replayed: true`, e a listagem
 *   tem UMA tarefa;
 * - a mesma chave num pedido diferente: 422 `IDEMPOTENCY_KEY_REUSED`; chave inválida: 400;
 * - sem o header, nada muda (duas requisições = duas tarefas): ele é opcional;
 * - o resultado é a resposta de sucesso, e não o erro: uma criação que falhou (404 de projeto alheio) não guarda nada;
 * - o CORS aceita `Idempotency-Key` e expõe `Idempotent-Replayed` ao front web.
 */
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  E2EContext,
  eventually,
  registerAndLogin,
  resetDatabase,
  startE2EApp,
  type TestUser,
} from './support/e2e-app';

describe('Idempotency-Key no POST /tasks (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let owner: TestUser;
  let intruder: TestUser;
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const tasksUrl = () => `/projects/${projectId}/tasks`;

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
    await resetDatabase(ctx.prisma);
    owner = await registerAndLogin(app, 'Dono');
    intruder = await registerAndLogin(app, 'Intruso');
    projectId = (
      await http()
        .post('/projects')
        .set(owner.auth)
        .send({ name: 'Idempotência' })
        .expect(201)
    ).body.id as string;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const titles = async () => {
    const res = await http().get(tasksUrl()).set(owner.auth).expect(200);
    return (res.body.items as Array<{ title: string }>).map((t) => t.title);
  };

  it('a nova tentativa devolve a MESMA resposta (mesmo taskId) e não cria outra tarefa', async () => {
    const key = randomUUID();
    const body = { title: 'Transferência de R$ 100' };

    const first = await http()
      .post(tasksUrl())
      .set(owner.auth)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);
    const retry = await http()
      .post(tasksUrl())
      .set(owner.auth)
      .set('Idempotency-Key', key)
      .send(body)
      .expect(201);

    expect(retry.body).toEqual(first.body);
    expect(first.headers['idempotent-replayed']).toBeUndefined();
    expect(retry.headers['idempotent-replayed']).toBe('true');
    await eventually(async () => {
      expect((await titles()).filter((t) => t === body.title)).toHaveLength(1);
    });
  });

  it('a mesma chave num pedido diferente: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const key = randomUUID();
    await http()
      .post(tasksUrl())
      .set(owner.auth)
      .set('Idempotency-Key', key)
      .send({ title: 'Pedido A' })
      .expect(201);

    const res = await http()
      .post(tasksUrl())
      .set(owner.auth)
      .set('Idempotency-Key', key)
      .send({ title: 'Pedido B' })
      .expect(422);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('chave inválida: 400 (o cliente pediu a garantia; ignorar em silêncio poderia duplicar)', async () => {
    await http()
      .post(tasksUrl())
      .set(owner.auth)
      .set('Idempotency-Key', 'tem espaço')
      .send({ title: 'X' })
      .expect(400);
  });

  it('sem o header: nada muda, duas requisições criam duas tarefas', async () => {
    const body = { title: 'Sem chave' };
    const a = await http()
      .post(tasksUrl())
      .set(owner.auth)
      .send(body)
      .expect(201);
    const b = await http()
      .post(tasksUrl())
      .set(owner.auth)
      .send(body)
      .expect(201);
    expect(a.body.taskId).not.toBe(b.body.taskId);
  });

  it('criação que falhou (404, projeto de outro usuário) não guarda nada: depois, a mesma chave funciona', async () => {
    const key = randomUUID();
    await http()
      .post(tasksUrl())
      .set(intruder.auth)
      .set('Idempotency-Key', key)
      .send({ title: 'Invasão' })
      .expect(404);

    const intruderProject = (
      await http()
        .post('/projects')
        .set(intruder.auth)
        .send({ name: 'Do intruso' })
        .expect(201)
    ).body.id as string;
    const res = await http()
      .post(`/projects/${intruderProject}/tasks`)
      .set(intruder.auth)
      .set('Idempotency-Key', key)
      .send({ title: 'Legítima' })
      .expect(201);
    expect(res.headers['idempotent-replayed']).toBeUndefined();
  });

  it('CORS: aceita Idempotency-Key no preflight e expõe Idempotent-Replayed', async () => {
    const preflight = await http()
      .options(tasksUrl())
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'idempotency-key,content-type')
      .expect(204);
    expect(
      String(preflight.headers['access-control-allow-headers']).toLowerCase(),
    ).toContain('idempotency-key');

    const res = await http()
      .get('/')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(String(res.headers['access-control-expose-headers'])).toContain(
      'Idempotent-Replayed',
    );
  });
});
