/**
 * Prazo depois do contract (Módulo 14.4b), via HTTP: o `dueDate` saiu da API, e quem o usava foi excluído ANTES pela
 * versão mínima.
 *
 * Protege a sequência que torna o contract seguro (ADR-0008):
 * - pré-condição: com a versão mínima acima da última que mandava `dueDate` (2.13), esse app recebe 426 e nunca chega
 *   à validação: o usuário vê "atualize", e não um erro de formulário;
 * - um cliente SEM versão (o 426 não o alcança) que ainda mande `dueDate` recebe 400 (`forbidNonWhitelisted`): é a
 *   quebra aprovada pela label `breaking-change`;
 * - o app atual cria com `due`, e listagem e histórico devolvem só `due` (o instante em UTC + o fuso), sem `dueDate`;
 * - `at` sem fuso, offset no lugar do fuso e fuso inexistente: 400.
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

describe('Prazo depois do contract: só due { at, timezone } (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let user: TestUser;
  let projectId: string;

  const http = () => request(app.getHttpServer());
  const currentApp = { 'X-Platform': 'android', 'X-App-Version': '2.14.0' };

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
    await resetDatabase(ctx.prisma);
    // A pré-condição do contract: mínima acima da última versão que mandava `dueDate`
    await ctx.prisma.appVersionPolicy.create({
      data: { platform: 'android', minVersion: '2.14.0', updatedBy: 'e2e' },
    });
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

  it('app 2.13 (o último que mandava dueDate): 426 antes de qualquer validação', async () => {
    const res = await http()
      .post(`/projects/${projectId}/tasks`)
      .set(user.auth)
      .set({ 'X-Platform': 'android', 'X-App-Version': '2.13.0' })
      .send({ title: 'Formato antigo', dueDate: '2026-12-31T23:59:59Z' })
      .expect(426);
    expect(res.body.code).toBe('APP_UPDATE_REQUIRED');
  });

  it('cliente sem versão que ainda manda dueDate: 400 (a quebra aprovada no contract)', async () => {
    const res = await http()
      .post(`/projects/${projectId}/tasks`)
      .set(user.auth)
      .send({ title: 'Formato antigo', dueDate: '2026-12-31T23:59:59Z' })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain(
      'property dueDate should not exist',
    );
  });

  it('app atual (due): listagem e histórico devolvem só due, sem dueDate e sem headers de depreciação', async () => {
    const res = await http()
      .post(`/projects/${projectId}/tasks`)
      .set(user.auth)
      .set(currentApp)
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

    await eventually(async () => {
      const list = await http()
        .get(`/projects/${projectId}/tasks`)
        .set(user.auth)
        .set(currentApp)
        .expect(200);
      const item = (list.body.items as Array<Record<string, unknown>>).find(
        (t) => t.id === taskId,
      );
      expect(item?.due).toEqual(expected);
      expect(item).not.toHaveProperty('dueDate');
    });

    const history = await http()
      .get(`/projects/${projectId}/tasks/${taskId}/history`)
      .set(user.auth)
      .set(currentApp)
      .expect(200);
    expect(history.body.current.due).toEqual(expected);
    expect(history.body.current).not.toHaveProperty('dueDate');
  });

  it.each([
    [
      'due.at sem fuso (ambíguo)',
      { at: '2026-12-31T23:59:59', timezone: 'UTC' },
      'fuso explícito',
    ],
    [
      'offset no lugar do fuso',
      { at: '2026-12-31T23:59:59Z', timezone: '-03:00' },
      'fuso IANA',
    ],
    [
      'fuso inexistente',
      { at: '2026-12-31T23:59:59Z', timezone: 'Terra/Media' },
      'fuso IANA',
    ],
  ])('400: %s', async (_label, due, message) => {
    const res = await http()
      .post(`/projects/${projectId}/tasks`)
      .set(user.auth)
      .set(currentApp)
      .send({ title: 'Inválida', due })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain(message);
  });
});
