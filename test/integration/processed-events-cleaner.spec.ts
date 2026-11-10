/**
 * Limpeza de `processed_events` por data, contra PostgreSQL REAL — Módulo 13.6c.
 *
 * Protege:
 * - só apaga as marcas mais velhas que a retenção, e só do PRÓPRIO grupo (outro grupo pode ter outra retenção);
 * - as recentes ficam: são elas que barram uma reentrega dentro da retenção do tópico;
 * - volume maior que um lote (12 mil marcas, lotes de 5 mil) é apagado inteiro, em várias rodadas;
 * - `start`/`stop`: a 1ª rodada é imediata, e o `stop` espera a rodada em andamento (o shutdown não fecha o Prisma
 *   no meio de um DELETE).
 */
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ProcessedEventsCleaner } from '../../src/common/messaging/processed-events.cleaner';
import { startTestDatabase, TestDatabase } from './support/test-database';

describe('ProcessedEventsCleaner (integração)', () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  const logger = new Logger('cleaner-test');

  const cleaner = (consumerGroup = 'notifications') =>
    new ProcessedEventsCleaner(prisma, {
      consumerGroup,
      retentionDays: 14,
      logger,
    });

  /** `count` marcas do grupo, processadas há `daysAgo` dias */
  const mark = (consumerGroup: string, daysAgo: number, count = 1) =>
    prisma.$executeRaw`
      INSERT INTO processed_events (consumer_group, event_id, processed_at)
      SELECT ${consumerGroup}, gen_random_uuid(),
             (now() AT TIME ZONE 'UTC') - make_interval(days => ${daysAgo}::int)
      FROM generate_series(1, ${count}::int)`;

  const countOf = (consumerGroup: string) =>
    prisma.processedEvent.count({ where: { consumerGroup } });

  beforeAll(async () => {
    db = await startTestDatabase();
    prisma = db.prisma;
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "processed_events"');
  });

  it('apaga só as marcas além da retenção, e só do próprio grupo', async () => {
    await mark('notifications', 15, 3); // além dos 14 dias
    await mark('notifications', 13, 2); // dentro: ficam
    await mark('notifications', 0, 1);
    await mark('billing', 30, 4); // outro grupo, com a sua própria retenção

    await expect(cleaner().cleanup()).resolves.toBe(3);

    expect(await countOf('notifications')).toBe(3);
    expect(await countOf('billing')).toBe(4);
  });

  it('12 mil marcas antigas (mais que um lote): apaga todas, em várias rodadas', async () => {
    await mark('notifications', 20, 12_000);
    await mark('notifications', 1, 5);

    await expect(cleaner().cleanup()).resolves.toBe(12_000);
    expect(await countOf('notifications')).toBe(5);
  });

  it('start limpa na hora; stop espera a rodada em andamento', async () => {
    await mark('notifications', 20, 50);
    const periodic = cleaner();

    periodic.start();
    await periodic.stop();

    expect(await countOf('notifications')).toBe(0);
  });

  it('marca recém-gravada pelo consumer (default do banco) não é apagada', async () => {
    await prisma.processedEvent.create({
      data: { consumerGroup: 'notifications', eventId: randomUUID() },
    });

    await expect(cleaner().cleanup()).resolves.toBe(0);
  });
});
