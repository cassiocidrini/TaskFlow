-- Módulo 14.4b, CONTRACT do prazo (passo 1 de 2): o backfill FINAL, no deploy em que o código para de gravar e de
-- ler a `due_date`.
--
-- Por que repetir o backfill da 14.4a: as migrações rodam antes do código novo, e no deploy da 14.4a a versão
-- anterior (que só conhecia a `due_date`) ainda criou linhas depois do primeiro backfill. Até aqui, a leitura cobria
-- essas linhas com `due_at ?? due_date`; a partir deste deploy, lê só a `due_at`. Idempotente: linha já copiada não muda.
--
-- A coluna NÃO é removida aqui. Durante este deploy, a versão anterior (14.4a) ainda está no ar e ainda grava nela:
-- um DROP agora faria os INSERTs dela falharem. O DROP é o passo 2, num deploy separado (14.4c).
UPDATE "tasks_read"
SET "due_at" = "due_date"
WHERE "due_at" IS NULL
  AND "due_date" IS NOT NULL;
