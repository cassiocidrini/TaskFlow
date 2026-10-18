import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { randomUUID } from 'crypto';
import request from 'supertest';
import { configureApp } from '../../../src/app.setup';

/*
 * Infraestrutura compartilhada dos testes E2E.
 *
 * Existe para que cada suíte E2E tenha ~10 linhas de setup em vez de ~70 — e, principalmente, para que as
 * armadilhas (ordem de carregamento do AppModule, limpeza respeitando FKs, consistência eventual) sejam
 * resolvidas UMA vez, num lugar comentado. Setup de teste copiado diverge na primeira mudança, como código.
 */

/** O que cada suíte E2E recebe: a app pronta, um Prisma para inspecionar o banco e um `close` que limpa tudo. */
export interface E2EContext {
  app: INestApplication;
  /** Prisma "de fora" da app: para preparar/inspecionar o banco nos testes */
  prisma: PrismaClient;
  close(): Promise<void>;
}

/**
 * Sobe um Postgres real (Testcontainers), aplica as migrações e inicializa a app
 * com a MESMA configuração de produção (configureApp).
 */
export async function startE2EApp(): Promise<E2EContext> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('test_db')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionString = container.getConnectionUri();
  process.env.DATABASE_URL = connectionString;
  process.env.JWT_SECRET = 'e2e-test-secret-com-no-minimo-32-caracteres';
  process.env.JWT_EXPIRES_IN = '1h';

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'pipe',
  });

  // Carregamento TARDIO de propósito: o ConfigModule valida o ambiente no momento em que o
  // AppModule é carregado. Um import estático rodaria ANTES de definirmos o DATABASE_URL acima
  // (e, localmente, apontaria para o banco de dev!). require (e não import()) porque, com
  // module "nodenext", import() exige extensão .js.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../../src/app.module') as typeof import('../../../src/app.module');

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  return {
    app,
    prisma,
    async close() {
      await app.close();
      await prisma.$disconnect();
      await container.stop();
    },
  };
}

/** Isola os testes: esvazia TODAS as tabelas de domínio (CASCADE resolve a ordem das FKs). */
export async function resetDatabase(prisma: PrismaClient): Promise<void> {
  // String constante (sem interpolação de entrada) — o "Unsafe" aqui não abre brecha de SQL injection
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "tasks_read", "events", "Task", "Project", "User" RESTART IDENTITY CASCADE',
  );
}

/** Usuário de teste já autenticado — os E2E de tarefas usam dois (dono e intruso) para provar a autorização. */
export interface TestUser {
  userId: string;
  email: string;
  token: string;
  /** Header pronto: .set(user.auth) */
  auth: { Authorization: string };
}

/** Cria um usuário com e-mail único e faz login. */
export async function registerAndLogin(app: INestApplication, name = 'Usuario E2E'): Promise<TestUser> {
  const email = `e2e-${randomUUID()}@taskflow.dev`;
  const password = 'senha12345';

  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ email, name, password })
    .expect(201);

  const login = await request(app.getHttpServer()).post('/auth/login').send({ email, password }).expect(201);
  const token = login.body.accessToken as string;

  return {
    userId: registered.body.userId as string,
    email,
    token,
    auth: { Authorization: `Bearer ${token}` },
  };
}

/**
 * Consistência EVENTUAL: as projeções rodam DEPOIS que a resposta HTTP já saiu
 * (o EventBus é fire-and-forget). Repete a asserção até passar ou estourar o tempo —
 * em vez de um `sleep(500)` fixo, que é lento quando sobra e instável quando falta.
 */
export async function eventually(assertion: () => Promise<void>, timeoutMs = 3_000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
