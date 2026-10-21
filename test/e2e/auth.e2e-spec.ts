/**
 * Autenticação via HTTP, com a MESMA configuração da produção (`configureApp`) e PostgreSQL real.
 *
 * Protege: 201/409 no cadastro, 400 para entrada inválida e para campo extra (mass assignment), login emitindo
 * um JWT de 3 partes e as variações de 401 (sem token, token falso, header malformado).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { E2EContext, resetDatabase, startE2EApp } from './support/e2e-app';

describe('Auth (e2e)', () => {
  let ctx: E2EContext;
  let app: INestApplication;

  beforeAll(async () => {
    ctx = await startE2EApp(); // Postgres real + migrações + app com a configuração de produção
    app = ctx.app;
  }, 180_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  // ============================================================
  // POST /auth/register
  // ============================================================
  describe('POST /auth/register', () => {
    it('deve registrar um usuário e retornar 201', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'teste@test.com', name: 'Cassio', password: 'senha12345' })
        .expect(201);

      expect(response.body).toEqual({
        userId: expect.any(String),
        email: 'teste@test.com',
        name: 'Cassio',
      });
      expect(response.body).not.toHaveProperty('password');
    });

    it('deve retornar 409 se o email já existir', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'teste@test.com', name: 'Cassio', password: 'senha12345' })
        .expect(201);

      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'teste@test.com', name: 'Outro', password: 'outrasenha' })
        .expect(409);
    });

    it('deve retornar 400 se o email for inválido', async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'nao-e-email', name: 'Cassio', password: 'senha12345' })
        .expect(400);
    });

    it('deve retornar 400 se a senha for menor que 8 caracteres', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'teste@test.com', name: 'Cassio', password: 'curta' })
        .expect(400);

      expect(response.body.message).toContain('Senha deve ter ao menos 8 caracteres');
    });

    it('deve retornar 400 se vier campo extra (mass assignment)', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/register')
        .send({
          email: 'teste@test.com',
          name: 'Cassio',
          password: 'senha12345',
          isAdmin: true,
        })
        .expect(400);

      expect(response.body.message).toContain('property isAdmin should not exist');
    });
  });

  // ============================================================
  // POST /auth/login
  // ============================================================
  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'teste@test.com', name: 'Cassio', password: 'senha12345' });
    });

    it('deve retornar um accessToken com credenciais válidas', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'teste@test.com', password: 'senha12345' })
        .expect(200);   // login não cria recurso: 200, não 201

      expect(response.body).toHaveProperty('accessToken');
      expect(typeof response.body.accessToken).toBe('string');
      expect(response.body.accessToken.split('.')).toHaveLength(3);
    });

    it('deve retornar 401 com senha errada', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'teste@test.com', password: 'senha-errada' })
        .expect(401);
    });

    it('deve retornar 401 com email inexistente', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'inexistente@test.com', password: 'senha12345' })
        .expect(401);
    });
  });

  // ============================================================
  // GET /auth/me
  // ============================================================
  describe('GET /auth/me', () => {
    let token: string;

    beforeEach(async () => {
      await request(app.getHttpServer())
        .post('/auth/register')
        .send({ email: 'teste@test.com', name: 'Cassio', password: 'senha12345' });

      const login = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'teste@test.com', password: 'senha12345' });

      token = login.body.accessToken;
    });

    it('deve retornar os dados do usuário com token válido', async () => {
      const response = await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body).toEqual({
        userId: expect.any(String),
        email: 'teste@test.com',
      });
    });

    it('deve retornar 401 sem token', async () => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .expect(401);
    });

    it('deve retornar 401 com token inválido', async () => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'Bearer token-falso')
        .expect(401);
    });

    it('deve retornar 401 com header Authorization malformado', async () => {
      await request(app.getHttpServer())
        .get('/auth/me')
        .set('Authorization', 'sem-bearer')
        .expect(401);
    });
  });
});