import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * Lock de ESCRITA na outbox por agregado (Módulo 13.6b): advisory lock de transação, solto pelo Postgres no COMMIT
 * ou ROLLBACK (inclusive se o processo morrer).
 *
 * **Por que existe.** A ordem por chave da outbox (13.2) se apoiava na concorrência otimista: para a mesma tarefa,
 * duas gravações da API nunca se intercalam (a segunda falha no `UNIQUE (aggregate_id, version)`). Isso só vale com
 * a API como ÚNICO escritor. O replay é um segundo escritor que não passa pela versão:
 * ```
 * replay lê v1..v4 da tarefa X
 *                         API grava v5 da tarefa X → outbox id 1000
 * replay grava v1..v4    → outbox ids 1001..1004    (o consumer receberia v5 ANTES de v1)
 * ```
 * `SERIALIZABLE` não resolveria: o `BIGSERIAL` é atribuído no INSERT, não na ordem de commit. Com os dois escritores
 * pegando ESTE lock antes de gravar, as gravações da mesma tarefa se serializam, e a ordem de id volta a ser a ordem
 * de versão.
 *
 * **Custo.** Uma instrução a mais por gravação da API, sem disputa no caso comum (tarefas diferentes, chaves
 * diferentes). Duas tarefas com o mesmo `hashtext` só se serializam à toa: correto, só mais lento.
 *
 * Forma de DUAS chaves (`int4, int4`): o espaço `taskflow.outbox-aggregate` não colide com o lock de chave única do
 * relay (`pg_try_advisory_xact_lock(hashtext('taskflow.outbox-relay'))`).
 */
export function lockAggregateForOutbox(
  db: PrismaClient | Prisma.TransactionClient,
  aggregateId: string,
): Prisma.PrismaPromise<number> {
  // $executeRaw, e não $queryRaw: a função devolve `void`, que o Prisma não desserializa (problema 12 do Módulo 07)
  return db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('taskflow.outbox-aggregate'), hashtext(${aggregateId}))`;
}
