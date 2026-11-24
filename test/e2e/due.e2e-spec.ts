/**
 * Expand do prazo via HTTP (Módulo 14.4a): o app ANTIGO e o app NOVO usando a mesma API ao mesmo tempo.
 *
 * Protege o contrato da fase expand:
 * - o app antigo manda `dueDate` e continua funcionando: 201, a listagem e o histórico devolvem o `dueDate` que ele lê,
 *   e a resposta traz `Deprecation`, `Sunset` e `Link` (expostos pelo CORS ao front web);
 * - o app novo manda `due { at, timezone }`: sem headers de depreciação, e recebe o instante em UTC + o fuso;
 * - os dois juntos, `at` sem fuso e fuso que não é IANA: 400;
 * - o prazo do formato antigo sai com `timezone: null` (desconhecido), nunca com um fuso inventado.
 */
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

describe('Prazo: dueDate (antigo) e due (novo) lado a lado (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let user: TestUser;
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const oldApp = { 'X-Platform': 'android', 'X-App-Version': '2.13.0' };
  const newApp = { 'X-Platform': 'android', 'X-App-Version': '2.14.0' };

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
    await resetDatabase(ctx.prisma);
    user = await registerAndLogin(app, 'Dono');
    projectId = (
      await http()
        .post('/projects')
        .set(user.auth)
        .send({ name: 'Prazos' })
        .expect(201)
    ).body.id;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  const listed = async (taskId: string) => {
    let item: Record<string, unknown> | undefined;
    await eventually(async () => {
      const res = await http()
        .get(`/projects/${projectId}/tasks`)
        .set(user.auth)
        .expect(200);
      item = (res.body.items as Array<Record<string, unknown>>).find(
        (t) => t.id === taskId,
      );
      expect(item).toBeDefined();
    });
    return item!;
  };

  it('app antigo (dueDate): 201 com Deprecation/Sunset/Link, e lê o dueDate de volta; o fuso fica null', async () => {
    const res = await http()
      .post(`/projects/${projectId}/tasks`)
      .set(user.auth)
      .set(oldApp)
      .set('Origin', 'http://localhost:5173')
      .send({ title: 'Formato antigo', dueDate: '2026-12-31T23:59:59Z' })
      .expect(201);

    expect(res.headers.deprecation).toMatch(/^@\d+$/);
    expect(res.headers.sunset).toBe('Mon, 01 Mar 2027 00:00:00 GMT');
    expect(res.headers.link).toContain('rel="deprecation"');
    const exposed = String(res.headers['access-control-expose-headers']);
    expect(exposed).toContain('Deprecation');
    expect(exposed).toContain('Sunset');

    const item = await listed(res.body.taskId as string);
    expect(item.dueDate).toBe('2026-12-31T23:59:59.000Z');
    expect(item.due).toEqual({
      at: '2026-12-31T23:59:59.000Z',
      timezone: null,
    });
  });

  it('app novo (due): sem headers de depreciação; instante em UTC + o fuso, na listagem e no histórico', async () => {
    const res = await http()
      .post(`/projects/${projectId}/tasks`)
      .set(user.auth)
      .set(newApp)
      .send({
        title: 'Formato novo',
        due: { at: '2026-12-31T23:59:59-03:00', timezone: 'America/Sao_Paulo' },
      })
      .expect(201);

    expect(res.headers.deprecation).toBeUndefined();
    const taskId = res.body.taskId as string;
    const expected = {
      at: '2027-01-01T02:59:59.000Z',
      timezone: 'America/Sao_Paulo',
    };

    const item = await listed(taskId);
    expect(item.due).toEqual(expected);
    expect(item.dueDate).toBe(expected.at); // o app antigo, lendo a mesma tarefa, continua vendo o prazo

    const history = await http()
      .get(`/projects/${projectId}/tasks/${taskId}/history`)
      .set(user.auth)
      .expect(200);
    expect(history.body.current).toMatchObject({
      due: expected,
      dueDate: expected.at,
    });
  });

  it.each([
    [
      'os dois formatos juntos',
      {
        dueDate: '2026-12-31T23:59:59Z',
        due: { at: '2026-12-31T23:59:59Z', timezone: 'UTC' },
      },
      'não os dois',
    ],
    [
      'due.at sem fuso (ambíguo)',
      { due: { at: '2026-12-31T23:59:59', timezone: 'UTC' } },
      'fuso explícito',
    ],
    [
      'offset no lugar do fuso',
      { due: { at: '2026-12-31T23:59:59Z', timezone: '-03:00' } },
      'fuso IANA',
    ],
    [
      'fuso inexistente',
      { due: { at: '2026-12-31T23:59:59Z', timezone: 'Terra/Media' } },
      'fuso IANA',
    ],
  ])('400: %s', async (_label, body, message) => {
    const res = await http()
      .post(`/projects/${projectId}/tasks`)
      .set(user.auth)
      .send({ title: 'Inválida', ...body })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain(message);
  });
});
