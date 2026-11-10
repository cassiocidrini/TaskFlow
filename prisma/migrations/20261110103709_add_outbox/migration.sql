-- Transactional Outbox (Módulo 13.2).
--
-- Tabela NOVA, sem tocar em `events`: migração aditiva, sem lock em tabela existente nem backfill. Eventos
-- gravados antes dela não entram na outbox; republicar o histórico é um replay a partir de `events` (13.6).
-- O índice parcial cobre só as linhas pendentes, a única consulta quente (a do relay).
-- CreateTable
CREATE TABLE "outbox" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "message_key" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_id_key" ON "outbox"("event_id");

-- CreateIndex
CREATE INDEX "outbox_pending_idx" ON "outbox"("id") WHERE (published_at IS NULL);
