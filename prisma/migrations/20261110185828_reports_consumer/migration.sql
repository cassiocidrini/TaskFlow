-- Contexto de relatórios (Módulo 13.6a): tabelas do consumer group `reports` do Kafka.
--
-- Migração aditiva (só tabelas novas), sem FKs para as tabelas da API: outro contexto, os ids chegam pelos eventos.
-- Os CHECKs no fim não existem no schema do Prisma (que não modela CHECK, e por isso não os vê como drift): um bug
-- no cálculo de delta vira ERRO na transação, em vez de um contador negativo gravado em silêncio.
-- CreateEnum
CREATE TYPE "ReportTaskStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE');

-- CreateTable
CREATE TABLE "report_tasks" (
    "task_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "status" "ReportTaskStatus" NOT NULL,
    "assignee_id" UUID,
    "task_created_at" TIMESTAMP(3) NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_tasks_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "project_stats" (
    "project_id" UUID NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "pending" INTEGER NOT NULL DEFAULT 0,
    "in_progress" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "unassigned_open" INTEGER NOT NULL DEFAULT 0,
    "lead_time_seconds_sum" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "last_event_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_stats_pkey" PRIMARY KEY ("project_id")
);

-- Contadores nunca negativos
ALTER TABLE "project_stats" ADD CONSTRAINT "project_stats_counters_non_negative" CHECK (
    "total" >= 0 AND "pending" >= 0 AND "in_progress" >= 0 AND "done" >= 0 AND "unassigned_open" >= 0
    AND "lead_time_seconds_sum" >= 0
);
