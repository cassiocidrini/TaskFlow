-- Envelope de metadados dos eventos (eventId, actorId, correlationId, schemaVersion).
--
-- Migração ADITIVA e segura em tabela grande: desde o PostgreSQL 11, ADD COLUMN com default constante só
-- altera o catálogo (sem reescrever a tabela nem segurar lock longo). O payload dos eventos não muda.
-- Eventos anteriores ficam com '{}' = autor desconhecido. Não há backfill de propósito: inventar o autor
-- de um evento antigo seria falsificar a auditoria.
ALTER TABLE "events" ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}';
