import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const events = await prisma.event.findMany({ orderBy: { version: 'asc' } });

  if (events.length === 0) {
    console.log('Nenhum evento no Event Store.');
    return;
  }

  console.log(`[OK] ${events.length} evento(s) no Event Store:\n`);

  for (const e of events) {
    console.log(`  [v${e.version}] ${e.eventType}`);
    console.log(`         aggregate: ${e.aggregateType}#${e.aggregateId}`);
    console.log(`         payload:   ${JSON.stringify(e.payload)}`);
    console.log(`         criado em: ${e.createdAt.toISOString()}`);
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});