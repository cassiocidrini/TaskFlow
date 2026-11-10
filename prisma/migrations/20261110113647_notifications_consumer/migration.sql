-- Contexto de notificações (Módulo 13.4): tabelas do consumer group `notifications` do Kafka.
--
-- Migração aditiva (só tabelas novas). `processed_events` é a idempotência do consumer: a PK (consumer_group,
-- event_id) faz uma reentrega do mesmo evento bater no INSERT ... ON CONFLICT DO NOTHING, na mesma transação do
-- efeito. Sem FKs para as tabelas da API: é outro contexto, e os ids chegam pelos eventos.
-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('TASK_ASSIGNED', 'TASK_COMPLETED');

-- CreateTable
CREATE TABLE "processed_events" (
    "consumer_group" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("consumer_group","event_id")
);

-- CreateTable
CREATE TABLE "notification_tasks" (
    "task_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "assignee_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_tasks_pkey" PRIMARY KEY ("task_id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "NotificationType" NOT NULL,
    "task_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "message" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_created_at_id_idx" ON "notifications"("user_id", "created_at" DESC, "id" DESC);
