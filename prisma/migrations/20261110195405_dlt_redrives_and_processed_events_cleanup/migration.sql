-- Redrive do DLT e limpeza de `processed_events` (Módulo 13.6c).
--
-- `dlt_redrives`: auditoria do comando `npm run redrive` (o que foi reenviado, por quem, quando) e a garantia de não
-- reenviar a mesma mensagem do DLT duas vezes (PK = a posição dela no DLT).
-- Índice em `processed_events.processed_at`: a limpeza por data apaga em lotes `WHERE processed_at < corte`; sem ele,
-- cada lote varreria a tabela inteira. Migração aditiva.

-- CreateTable
CREATE TABLE "dlt_redrives" (
    "consumer_group" TEXT NOT NULL,
    "dlt_topic" TEXT NOT NULL,
    "dlt_partition" INTEGER NOT NULL,
    "dlt_offset" BIGINT NOT NULL,
    "event_id" TEXT,
    "reason" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "redriven_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dlt_redrives_pkey" PRIMARY KEY ("dlt_topic","dlt_partition","dlt_offset")
);

-- CreateIndex
CREATE INDEX "processed_events_processed_at_idx" ON "processed_events"("processed_at");

