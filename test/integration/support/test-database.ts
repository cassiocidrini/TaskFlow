import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

/** Banco de teste descartável: o Prisma apontando para ele e um `stop` que derruba o container. */
export interface TestDatabase {
  prisma: PrismaClient;
  stop(): Promise<void>;
}

/**
 * PostgreSQL REAL (Testcontainers) com todas as migrações aplicadas — para testes de integração.
 *
 * Por que banco real, e não um mock ou SQLite em memória: os testes de integração existem para provar
 * CONTRATOS COM O BANCO — `UNIQUE` atômico, `INSERT … ON CONFLICT`, tipos enum, JSONB. Nada disso é simulável
 * com fidelidade. Mesma imagem (postgres:16), mesmas migrações da produção, banco limpo a cada execução.
 *
 * Custo: ~10–30 s para subir o container. Por isso as suítes rodam com `--runInBand` (uma de cada vez) e
 * com timeout de 60 s (`test/setup-slow-suites.ts`).
 */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('test_db')
    .withUsername('test')
    .withPassword('test')
    .start();

  const connectionString = container.getConnectionUri();

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: connectionString },
    stdio: 'pipe',
  });

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  return {
    prisma,
    async stop() {
      await prisma.$disconnect();
      await container.stop();
    },
  };
}
