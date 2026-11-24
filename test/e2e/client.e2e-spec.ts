/**
 * `X-Platform` e `X-App-Version` via HTTP, com a MESMA configuração da produção (`configureApp`) — Módulo 14.1.
 *
 * Protege o contrato com os apps e o front web:
 * - identificar o cliente nunca recusa uma requisição: headers válidos, inválidos ou ausentes respondem igual, em
 *   rota pública e em rota protegida (o 401 continua sendo do JWT, não do header);
 * - o preflight de CORS libera os dois headers para a origem permitida: sem isso, o navegador barraria o front web
 *   antes de a requisição chegar à API.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { E2EContext, startE2EApp } from './support/e2e-app';

describe('Identificação do cliente (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it.each([
    ['válidos', { 'X-Platform': 'ios', 'X-App-Version': '2.14.0' }],
    ['inválidos', { 'X-Platform': 'symbian', 'X-App-Version': 'latest' }],
    ['ausentes', {}],
  ])('headers %s: a requisição segue normalmente', async (_label, headers) => {
    await request(app.getHttpServer()).get('/').set(headers).expect(200);
  });

  it('em rota protegida, quem decide é o JWT, não o header de versão', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set({ 'X-Platform': 'android', 'X-App-Version': '1.0.0' })
      .expect(401);
  });

  it('preflight de CORS libera X-Platform e X-App-Version para a origem permitida', async () => {
    const response = await request(app.getHttpServer())
      .options('/projects')
      .set('Origin', 'http://localhost:5173')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-platform,x-app-version')
      .expect(204);

    const allowed = String(
      response.headers['access-control-allow-headers'],
    ).toLowerCase();
    expect(allowed).toContain('x-platform');
    expect(allowed).toContain('x-app-version');
  });
});
