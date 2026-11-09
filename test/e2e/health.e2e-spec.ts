/**
 * Probes `/health/live` e `/health/ready` via HTTP, com a MESMA configuração da produção (`configureApp`) e
 * PostgreSQL real.
 *
 * Protege o contrato com o orquestrador: as duas rotas respondem SEM token (probe não autentica, e o guard de JWT
 * fica nos controllers de negócio), o readiness consulta o banco de verdade e a resposta não carrega detalhes de
 * infraestrutura. A falha do readiness (banco fora, drenagem) é coberta em `unit/health.spec.ts` e
 * `integration/graceful-shutdown.spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { E2EContext, startE2EApp } from './support/e2e-app';

describe('Health checks (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('GET /health/live deve responder 200 sem token e sem consultar dependências', async () => {
    const response = await request(app.getHttpServer()).get('/health/live').expect(200);

    expect(response.body).toEqual({ status: 'ok', info: {}, error: {}, details: {} });
  });

  it('GET /health/ready deve responder 200 sem token, com o banco e o encerramento como up', async () => {
    const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      info: { shutdown: { status: 'up' }, database: { status: 'up' } },
    });
  });

  it('deve manter o X-Correlation-Id também nos probes', async () => {
    const response = await request(app.getHttpServer())
      .get('/health/ready')
      .set('X-Correlation-Id', 'probe-1')
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe('probe-1');
  });
});
