/**
 * Script de inspeção do Event Store: `npm run events:list`.
 *
 * Imprime TODOS os eventos gravados — útil para estudar o Event Sourcing "por dentro" (ver as versões
 * crescendo por agregado e os payloads exatos). É uma ferramenta de desenvolvimento, não código da API.
 *
 * Roda fora do NestJS, por isso cria o próprio `PrismaClient` com o driver adapter (obrigatório no Prisma 7)
 * e lê o `.env` diretamente. Lê a tabela inteira de uma vez: aceitável para estudo; com milhões de eventos,
 * seria preciso paginar ou usar um cursor/stream para não estourar a memória (Módulo 11).
 *
 * Vive em `scripts/`, e não em `src/`, para não ser compilado no `dist/` nem entrar na imagem de produção.
 */
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
