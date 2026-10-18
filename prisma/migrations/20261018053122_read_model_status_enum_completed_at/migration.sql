-- ============================================================================
-- MIGRAÇÃO EDITADA À MÃO.
-- O Prisma gerou DROP COLUMN "status" + ADD COLUMN "status" — isso APAGARIA o status
-- de todas as tarefas (tudo viraria PENDING). Reescrito para converter NO LUGAR.
-- ============================================================================

-- Nova coluna (aditiva, nullable: sem risco)
ALTER TABLE "tasks_read" ADD COLUMN "completed_at" TIMESTAMP(3);

-- status: TEXT → enum "TaskStatus", PRESERVANDO os valores existentes.
-- 1) O default atual é texto ('PENDING'::text) e impediria a troca de tipo
ALTER TABLE "tasks_read" ALTER COLUMN "status" DROP DEFAULT;
-- 2) USING diz ao Postgres como converter cada linha (falha alto se houver valor fora do enum)
ALTER TABLE "tasks_read" ALTER COLUMN "status" TYPE "TaskStatus" USING "status"::"TaskStatus";
-- 3) Recoloca o default, agora tipado
ALTER TABLE "tasks_read" ALTER COLUMN "status" SET DEFAULT 'PENDING';
