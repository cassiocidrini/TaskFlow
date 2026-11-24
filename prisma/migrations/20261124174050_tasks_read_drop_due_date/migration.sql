-- Módulo 14.4c, CONTRACT do prazo (passo 2 de 2): a coluna `due_date` sai do banco.
--
-- Seguro só agora: desde o deploy da 14.4b, nenhuma versão da API grava nem lê esta coluna. Se este DROP tivesse ido
-- junto com aquele código, a versão anterior (14.4a), ainda no ar durante o deploy, quebraria ao gravar nela.

-- O DROP COLUMN no Postgres é rápido (só marca a coluna como removida, sem reescrever a tabela), mas precisa de um
-- lock ACCESS EXCLUSIVE. Se uma consulta longa estiver usando a tabela, o ALTER espera, e toda requisição seguinte
-- entra na fila ATRÁS dele: a API trava. Com o lock_timeout, a migração desiste em 5 s (e pode rodar de novo) em vez
-- de travar. LOCAL: vale só para a transação desta migração.
SET LOCAL lock_timeout = '5s';

-- Última defesa contra perda de dado: o prazo de toda linha precisa já estar em `due_at` (backfills da 14.4a e da
-- 14.4b). Se o backfill tiver deixado alguma para trás, a migração para aqui, sem apagar nada.
DO $$
DECLARE
  sem_copia bigint;
BEGIN
  SELECT count(*) INTO sem_copia FROM "tasks_read" WHERE "due_date" IS NOT NULL AND "due_at" IS NULL;
  IF sem_copia > 0 THEN
    RAISE EXCEPTION '% linha(s) de tasks_read com due_date sem due_at: rode o backfill antes do DROP', sem_copia;
  END IF;
END $$;

ALTER TABLE "tasks_read" DROP COLUMN "due_date";
