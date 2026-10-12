import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const events = await prisma.event.findMany({ orderBy: { version: 'asc' } });
  console.log(`[OK] ${events.length} evento(s) no Event Store:\n`);
  for (const e of events) {
    console.log(`  [${e.version}] ${e.eventType} (${e.aggregateType}#${e.aggregateId})`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[X] Erro:', err);
  process.exit(1);
});