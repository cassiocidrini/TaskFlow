/**
 * Versão mínima do app via HTTP, com a MESMA configuração da produção (`configureApp`) — Módulo 14.2.
 *
 * Protege o contrato com os apps:
 * - abaixo da mínima, QUALQUER rota responde 426 com `code: APP_UPDATE_REQUIRED` e a `minVersion`, inclusive rota
 *   pública e rota protegida sem token (o app antigo vê "atualize", não "faça login");
 * - abaixo da recomendada, a resposta é a normal, com `X-App-Update` e a versão, expostos pelo CORS ao front web;
 * - quem não se identifica, outra plataforma e os probes de health passam;
 * - mudar a política vale sem reiniciar a API (aqui, cache desligado; em produção, até o TTL).
 */
import { INestApplication } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { E2EContext, resetDatabase, startE2EApp } from './support/e2e-app';

describe('Versão mínima do app (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
    prisma = ctx.prisma;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await prisma.appVersionPolicy.create({
      data: {
        platform: 'android',
        minVersion: '2.10.0',
        recommendedVersion: '2.12.0',
        updatedBy: 'e2e',
      },
    });
  });

  const android = (version: string) => ({
    'X-Platform': 'android',
    'X-App-Version': version,
  });

  it('abaixo da mínima: 426 com o code estável, em rota pública', async () => {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set(android('2.9.0'))
      .send({ email: 'x@x.dev', password: 'qualquer-coisa' })
      .expect(426);

    expect(response.body).toEqual({
      statusCode: 426,
      error: 'Upgrade Required',
      code: 'APP_UPDATE_REQUIRED',
      message: expect.any(String),
      platform: 'android',
      minVersion: '2.10.0',
    });
    expect(response.headers['x-correlation-id']).toBeDefined(); // o suporte ainda consegue rastrear
  });

  it('em rota protegida SEM token: 426, e não 401 (o app antigo vê "atualize", não "faça login")', async () => {
    await request(app.getHttpServer())
      .get('/auth/me')
      .set(android('1.0.0'))
      .expect(426);
  });

  it('abaixo da recomendada: resposta normal, com o aviso exposto ao front web pelo CORS', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set(android('2.11.3'))
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['x-app-update']).toBe('recommended');
    expect(response.headers['x-app-recommended-version']).toBe('2.12.0');
    const exposed = String(
      response.headers['access-control-expose-headers'],
    ).toLowerCase();
    expect(exposed).toContain('x-app-update');
    expect(exposed).toContain('x-app-recommended-version');
  });

  it('na recomendada: sem aviso', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set(android('2.12.0'))
      .expect(200);
    expect(response.headers['x-app-update']).toBeUndefined();
  });

  it('quem não se identifica, outra plataforma e os probes passam', async () => {
    await request(app.getHttpServer()).get('/').expect(200);
    await request(app.getHttpServer())
      .get('/')
      .set({ 'X-App-Version': '1.0.0' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/')
      .set({ 'X-Platform': 'ios', 'X-App-Version': '1.0.0' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/health/live')
      .set(android('1.0.0'))
      .expect(200);
  });

  it('mudar a política vale sem reiniciar a API', async () => {
    await request(app.getHttpServer())
      .get('/')
      .set(android('2.10.5'))
      .expect(200);

    await prisma.appVersionPolicy.update({
      where: { platform: 'android' },
      data: { minVersion: '2.11.0' },
    });

    await request(app.getHttpServer())
      .get('/')
      .set(android('2.10.5'))
      .expect(426);
  });
});
