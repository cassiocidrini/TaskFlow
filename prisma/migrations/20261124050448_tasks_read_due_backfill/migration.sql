-- Módulo 14.4, BACKFILL do expand/contract: copia o prazo das linhas que já existiam para as colunas novas.
-- O fuso fica NULL (desconhecido): o formato antigo não o registrava, e inventar um seria gravar como fato o que
-- ninguém disse.
--
-- Idempotente (`WHERE due_at IS NULL`), e de propósito: as migrações rodam ANTES do código novo subir, então durante
-- o deploy a versão anterior da API ainda pode criar linhas só com `due_date`. Essas escapam deste UPDATE; enquanto
-- isso, a leitura usa `due_at ?? due_date`, e o contract (14.4b) repete este UPDATE antes de remover a coluna.
--
-- Uma instrução só porque a tabela é pequena. Com milhões de linhas: em lotes (`WHERE id IN (SELECT ... LIMIT n)`),
-- fora da migração, para não segurar lock de linha nem gerar uma transação gigante no WAL.
UPDATE "tasks_read"
SET "due_at" = "due_date"
WHERE "due_at" IS NULL
  AND "due_date" IS NOT NULL;
