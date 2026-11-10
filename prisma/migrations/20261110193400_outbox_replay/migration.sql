-- Replay do histórico pela outbox (Módulo 13.6b).
--
-- `replay`: a linha é republicação do Event Store, e não um evento novo da API. O relay a publica com o header
-- `replay: true`, e cada consumer group decide se aplica (projeções) ou ignora (efeitos, como notificações).
--
-- O UNIQUE de `event_id` vira PARCIAL (só linhas da API): continua impedindo a API de gravar o mesmo evento duas
-- vezes, e deixa o replay republicar um evento que ainda está na outbox (as publicadas ficam 72 h).

-- DropIndex
DROP INDEX "outbox_event_id_key";

-- AlterTable
ALTER TABLE "outbox" ADD COLUMN     "replay" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_id_key" ON "outbox"("event_id") WHERE (NOT replay);
