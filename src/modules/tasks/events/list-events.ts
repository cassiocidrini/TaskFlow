/**
 * @deprecated **Script obsoleto e quebrado — use `npm run events:list` (`src/events/list-events.ts`).**
 *
 * Duplicata antiga do listador do Event Store. Não funciona no Prisma 7: o `PrismaClient` exige um
 * *driver adapter* (`@prisma/adapter-pg`) ou uma URL de conexão, e aqui ele é criado sem nenhum dos dois.
 * Não é importado por nenhum módulo da aplicação. Mantido apenas até a limpeza de `src/` (scripts de
 * estudo → `scripts/`), registrada como próximo passo na análise do projeto.
 */
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
