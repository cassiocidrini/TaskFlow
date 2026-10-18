import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import request from 'supertest';
import helmet from 'helmet';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;

beforeAll(async () => {
  console.log('[1] Subindo container Postgres...');
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('test_db')
    .withUsername('test')
    .withPassword('test')
    .start();
  console.log('[1] OK - container pronto:', container.getConnectionUri());

  const connectionString = container.getConnectionUri();
  process.env.DATABASE_URL = connectionString;
  process.env.JWT_SECRET = 'e2e-test-secret-com-no-minimo-32-caracteres';
  process.env.JWT_EXPIRES_IN = '1h';

  console.log('[2] Criando Prisma Client...');
  const adapter = new PrismaPg({ connectionString });
  prisma = new PrismaClient({ adapter });
  console.log('[2] OK');

  console.log('[3] Rodando migrações...');
  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'pipe',
  });
  console.log('[3] OK');

  console.log('[4] Criando aplicação NestJS...');
  // Carregamento TARDIO de propósito: o ConfigModule valida o ambiente no momento em que o
  // AppModule é carregado. Um import estático no topo rodaria ANTES deste beforeAll,
  // sem o DATABASE_URL do container (e, localmente, apontaria para o banco de dev!).
  // Usamos require (e não import()) porque, com module "nodenext", import() exige extensão .js.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../src/app.module') as typeof import('../../src/app.module');
  const moduleRef: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  })
    .compile();
  app = moduleRef.createNestApplication();
  console.log('[4] OK');

  console.log('[5] Configurando pipes...');
  app.use(helmet());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  console.log('[5] OK');

  console.log('[6] Inicializando app...');
  await app.init();
  console.log('[6] OK - app pronto!');
}, 180_000);

  afterAll(async () => {
    if (app) await app.close();
    if (prisma) await prisma.$disconnect();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    await prisma.user.deleteMany();
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
        .expect(201);

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