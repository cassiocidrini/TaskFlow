/**
 * `X-Correlation-Id` via HTTP, com a MESMA configuração da produção (`configureApp`).
 *
 * Protege o contrato que o cliente (front, app mobile, suporte) usa para citar uma chamada: o id enviado volta
 * igual; ausente ou inválido, a API gera um UUID e responde normalmente (correlação nunca vira 400); o header vem
 * também nas respostas de erro; e o CORS o expõe ao JavaScript de outra origem (`Access-Control-Expose-Headers`).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { E2EContext, startE2EApp } from './support/e2e-app';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('X-Correlation-Id (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await startE2EApp();
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  it('deve devolver o id enviado pelo cliente', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('X-Correlation-Id', 'chamado-1234')
      .expect(200);

    expect(response.headers['x-correlation-id']).toBe('chamado-1234');
  });

  it('deve gerar um UUID quando o cliente não envia o header', async () => {
    const response = await request(app.getHttpServer()).get('/').expect(200);

    expect(response.headers['x-correlation-id']).toMatch(UUID_V4);
  });

  it('deve trocar um id inválido por um UUID SEM recusar a requisição', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('X-Correlation-Id', 'a'.repeat(65))
      .expect(200);

    expect(response.headers['x-correlation-id']).toMatch(UUID_V4);
  });

  it('deve devolver o id também em respostas de erro', async () => {
    const response = await request(app.getHttpServer())
      .get('/auth/me')
      .set('X-Correlation-Id', 'erro-401')
      .expect(401);

    expect(response.headers['x-correlation-id']).toBe('erro-401');
  });

  it('deve expor o header via CORS para origens permitidas', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://localhost:5173')
      .expect(200);

    expect(response.headers['access-control-expose-headers']).toBe('X-Correlation-Id');
  });
});
