/**
 * Migração do `DROP COLUMN due_date` (Módulo 14.4c) contra PostgreSQL REAL (Testcontainers).
 *
 * Protege a última defesa contra perda de dado do expand/contract: o SQL da migração ABORTA, sem apagar nada, se
 * alguma linha ainda tiver o prazo só na coluna antiga (`due_date` preenchida e `due_at` vazia, um backfill que deixou
 * algo para trás). Com tudo copiado, ele remove a coluna.
 *
 * Por que um schema descartável: no banco de teste, todas as migrações já rodaram, e a `due_date` já não existe. O
 * teste recria, num schema só dele, a `tasks_read` como era antes do DROP, aponta o `search_path` para lá e roda o
 * arquivo da migração INTEIRO (vários comandos e um bloco `DO`), pelo driver `pg`: o Prisma executa um comando por vez.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { startTestDatabase, TestDatabase } from './support/test-database';

const DROP_SQL = (() => {
  const dir = join(__dirname, '..', '..', 'prisma', 'migrations');
  const folder = readdirSync(dir).find((name) =>
    name.endsWith('_tasks_read_drop_due_date'),
  );
  if (!folder) throw new Error('migração do DROP não encontrada');
  return readFileSync(join(dir, folder, 'migration.sql'), 'utf8');
})();

describe('Migração do DROP da due_date (integração)', () => {
  let db: TestDatabase;
  let client: Client;
  let schema: string;

  beforeAll(async () => {
    db = await startTestDatabase();
    client = new Client({ connectionString: db.connectionString });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await db?.stop();
  });

  beforeEach(async () => {
    // A tabela como era antes da 14.4c, num schema só deste teste
    schema = `pre_drop_${randomUUID().slice(0, 8)}`;
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(
      'CREATE TABLE tasks_read (id text PRIMARY KEY, due_date timestamp(3), due_at timestamp(3))',
    );
  });

  afterEach(async () => {
    await client.query('RESET search_path');
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
  });

  /** Roda a migração como o Prisma roda: numa transação. */
  const runMigration = async () => {
    await client.query('BEGIN');
    try {
      await client.query(DROP_SQL);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  };

  const columns = async () =>
    (
      await client.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 ORDER BY 1`,
        [schema],
      )
    ).rows.map((r) => r.column_name);

  it('linha com o prazo só na coluna antiga: aborta e não apaga nada', async () => {
    await client.query(
      `INSERT INTO tasks_read VALUES ('t1', '2026-12-31T23:59:59Z', NULL)`,
    );

    await expect(runMigration()).rejects.toThrow(
      '1 linha(s) de tasks_read com due_date sem due_at',
    );
    expect(await columns()).toEqual(['due_at', 'due_date', 'id']); // a coluna continua lá
  });

  it('tudo copiado (e linhas sem prazo): remove a coluna', async () => {
    await client.query(
      `INSERT INTO tasks_read VALUES ('t1', '2026-12-31T23:59:59Z', '2026-12-31T23:59:59Z')`,
    );
    await client.query(`INSERT INTO tasks_read VALUES ('t2', NULL, NULL)`);

    await runMigration();

    expect(await columns()).toEqual(['due_at', 'id']);
  });
});
