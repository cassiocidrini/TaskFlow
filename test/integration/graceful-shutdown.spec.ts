/**
 * Graceful shutdown contra PostgreSQL REAL (Testcontainers) e servidor HTTP de verdade (`listen(0)`).
 *
 * Protege a ORDEM do `app.close()`, que é o que separa um shutdown "gracioso" de um que só parece ser:
 * - uma requisição em andamento no início do encerramento termina com 200 e consegue usar o banco;
 * - depois do `close()`, nenhuma conexão da app fica aberta no Postgres. Na ordem antiga (Prisma desconectando no
 *   `onModuleDestroy`, ANTES de o HTTP fechar), a requisição atrasada não falhava (o Prisma reconecta sozinho),
 *   mas REABRIA o pool depois do disconnect, e essa conexão só morria com o processo. Medido: 1 conexão na
 *   ordem antiga, 0 na nova;
 * - durante a drenagem o servidor ainda atende, mas o `/health/ready` responde 503 e as respostas saem com
 *   `Connection: close`: o balanceador para de mandar tráfego antes de o servidor fechar.
 *
 * A rota lenta existe só neste teste (controller declarado aqui): o produto não ganha rota artificial.
 */
import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HealthModule } from '../../src/health/health.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { startTestDatabase, TestDatabase } from './support/test-database';

const DRAIN_MS = 300;
const SLOW_REQUEST_MS = 400; // maior que a drenagem: a requisição ainda roda quando o HTTP começa a fechar

/** Simula uma requisição demorada que usa o banco no FINAL, depois de o encerramento começar. */
@Controller('slow')
class SlowController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async slow() {
    await sleep(SLOW_REQUEST_MS);
    const [row] = await this.prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
    return { ok: row.ok };
  }
}

describe('Graceful shutdown (integração)', () => {
  let db: TestDatabase;
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    db = await startTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  // Uma app nova por teste: cada teste ENCERRA a sua
  beforeEach(async () => {
    @Module({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({ DATABASE_URL: db.connectionString, SHUTDOWN_DRAIN_MS: DRAIN_MS, SHUTDOWN_TIMEOUT_MS: 8_000 }),
          ],
        }),
        PrismaModule,
        HealthModule,
      ],
      controllers: [SlowController],
    })
    class ShutdownTestModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ShutdownTestModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  });

  it('deve concluir a requisição em andamento, COM banco, antes de desconectar o Prisma', async () => {
    const pending = fetch(`${baseUrl}/slow`);
    await sleep(50); // a requisição já entrou

    const closing = app.close(); // o mesmo caminho do SIGTERM com enableShutdownHooks
    const response = await pending;

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: 1 });
    await closing;
  });

  it('não deve deixar conexão da app aberta no Postgres depois do close (pool fechado DEPOIS do último uso)', async () => {
    const pending = fetch(`${baseUrl}/slow`);
    await sleep(50);
    await Promise.all([app.close(), pending]);

    // Sessões de cliente no banco de teste, menos a desta consulta (o Prisma auxiliar do teste usa uma conexão só)
    const openConnections = async () => {
      const [row] = await db.prisma.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`;
      return Number(row.n);
    };
    // O Postgres leva alguns ms para registrar o fim da conexão
    let n = await openConnections();
    for (let i = 0; i < 20 && n > 0; i++) {
      await sleep(50);
      n = await openConnections();
    }
    expect(n).toBe(0);
  });

  it('durante a drenagem: readiness 503, servidor ainda atendendo e respostas com Connection: close', async () => {
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);

    const closing = app.close();
    await sleep(50); // dentro da janela de drenagem (DRAIN_MS)

    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    expect(ready.headers.get('connection')).toBe('close');
    expect(await ready.json()).toMatchObject({
      status: 'error',
      error: { shutdown: { status: 'down' } },
      info: { database: { status: 'up' } }, // o banco está bem: quem tira a réplica é o encerramento
    });

    await closing;
  });
});
