-- Módulo 14.4, fase EXPAND do expand/contract: `due_date` → `due_at` + `due_timezone`.
-- Só ACRESCENTA colunas que aceitam NULL e não têm default: no Postgres é uma mudança só de metadados (sem reescrever
-- a tabela nem segurar lock longo), segura com a API no ar. A `due_date` continua aqui e continua sendo gravada:
-- durante um deploy, a versão ANTERIOR da API ainda roda e ainda a lê. Ela só sai na fase CONTRACT (14.4b).
-- Nunca `RENAME COLUMN` direto: a versão antiga, ainda no ar, procuraria a coluna velha e quebraria.
-- AlterTable
ALTER TABLE "tasks_read" ADD COLUMN     "due_at" TIMESTAMP(3),
ADD COLUMN     "due_timezone" TEXT;
