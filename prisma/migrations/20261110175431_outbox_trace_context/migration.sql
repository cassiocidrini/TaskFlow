-- Contexto de trace na outbox (Módulo 13): o `traceparent`/`tracestate` W3C de quem gravou o evento, para o trace
-- atravessar a fronteira assíncrona API → outbox → relay → Kafka → consumer.
--
-- Migração aditiva e nullable, sem backfill: as linhas já existentes não têm contexto para recuperar e são
-- publicadas sem o header, como antes.
-- AlterTable
ALTER TABLE "outbox" ADD COLUMN     "trace_context" JSONB;
