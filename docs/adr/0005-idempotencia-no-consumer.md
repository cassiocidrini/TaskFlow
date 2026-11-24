# ADR-0005: Idempotência no consumer: tabela de marcas ou versão do agregado

- **Status:** Aceito
- **Decisão:** 10/11/2026 (Módulos 13.4, 13.6a e 13.6c) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0002](0002-transactional-outbox-com-relay-por-polling.md) (de onde vêm as duplicatas) ·
  [ADR-0003](0003-chave-de-particao-por-tarefa.md) · [ADR-0006](0006-retry-classificado-e-dlt-por-grupo.md)

## Contexto

O Kafka entrega a mesma mensagem mais de uma vez em situações **normais**, não só em falhas raras:

- o relay publica, perde o COMMIT e republica o lote ([ADR-0002](0002-transactional-outbox-com-relay-por-polling.md));
- um consumer faz o efeito e cai antes de commitar o offset;
- um rebalance entrega a partição a outro membro no meio do processamento;
- alguém volta o offset de um grupo para reprocessar.

Impedir a duplicata na entrega exigiria uma transação entre o Kafka e o Postgres, que não existe. As transações do
próprio Kafka (EOS: `transactional.id` + `read_committed`) só valem de Kafka para Kafka; um efeito gravado no Postgres
continua precisando de proteção.

## Decisão

**At-least-once na entrega + consumer idempotente = efeito exatamente uma vez.** Toda regra abaixo vale para todo
consumer group:

1. **O offset é commitado DEPOIS do efeito.** Commitar antes seria *at-most-once*: um crash perderia o evento sem
   ninguém saber.
2. **A checagem de duplicata e o efeito ficam na MESMA transação.** Separados, recriariam o dual-write do lado do
   consumer: marca sem efeito perde a notificação; efeito sem marca a duplica.

E duas formas de reconhecer a duplicata, escolhidas pelo tipo de efeito:

| | `notifications`: **tabela de marcas** | `reports`: **versão do agregado** |
|---|---|---|
| Como | `INSERT INTO processed_events (consumer_group, event_id) ON CONFLICT DO NOTHING`; 0 linhas = já processado | `report_tasks` guarda a última `aggregateVersion` aplicada; `FOR UPDATE` + guarda `>=` |
| Quando serve | O efeito **não tem estado** com que comparar (inserir uma notificação) | Há **estado por chave**, com ordem por chave |
| Custo | Uma linha por evento, apagada por um job depois da retenção | Uma linha por tarefa, que não cresce com os eventos |
| Versão antiga chegando depois da nova | Não reconhece (o `eventId` é outro) | Reconhece |

**A retenção das marcas é amarrada à do tópico:** a marca precisa viver enquanto o mesmo evento pode chegar de novo
(7 dias, o rewind dentro da retenção). `PROCESSED_EVENTS_RETENTION_DAYS` tem padrão 14, e o **schema recusa ≤ 7**: a
regra está no código, não só neste documento.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Confiar na entrega** ("o Kafka não duplica") | Duplica, nas quatro situações do contexto |
| **Transações do Kafka (EOS)** | Não cobrem um efeito no Postgres |
| **`UNIQUE(event_id)` na tabela de efeito** | Funciona quando o efeito é um INSERT; a tabela de marcas generaliza para efeitos que não são (atualizar um saldo, chamar uma API externa) |
| **Marca fora da transação** (Redis, ou commit separado) | Recria o dual-write: um crash entre as duas escritas perde ou duplica o efeito |
| **Guarda estrita "tem que ser a versão seguinte"** | Detectaria buracos, mas o contrato permite eventos internos não publicados ([ADR-0004](0004-evento-de-integracao-separado-do-dominio.md)): um buraco de versão pode ser legítimo |
| **Contador por "ler, somar no Node e gravar"** | *Lost update* entre partições ([ADR-0003](0003-chave-de-particao-por-tarefa.md)): o `reports` usa `SET coluna = coluna + delta` |

## Consequências

**Positivas**
- Reprocessar é seguro: replay do Event Store, rewind de offset e grupo novo lendo o histórico não duplicam efeitos.
- Entregas **simultâneas** do mesmo evento também ficam corretas (o segundo INSERT espera o lock da PK; o `FOR UPDATE`
  serializa a guarda de versão).

**Negativas**
- **`processed_events` cresce** com o volume e precisa de limpeza periódica, em lotes.
- **A guarda de versão impede o redrive** do DLT para o `reports`: a mensagem reenviada chega atrás de versões mais
  novas e é tratada como duplicata. O caminho, para esse grupo, é a reconstrução pelo replay
  ([ADR-0006](0006-retry-classificado-e-dlt-por-grupo.md)).
- Toda transação de consumer paga uma escrita a mais (a marca) ou um lock de linha (a guarda).
- **Efeito externo não é coberto pela marca no Postgres:** chamar uma API de fora dentro da transação não desfaz a
  chamada no rollback. Para isso, a idempotência vai para a ponta: é o que a Lambda do push faz
  ([ADR-0007](0007-kafka-para-fatos-sqs-para-trabalho.md)).

## Revisitar quando

- **A retenção do tópico mudar:** o mínimo do schema de `PROCESSED_EVENTS_RETENTION_DAYS` muda junto.
- **O volume tornar a tabela de marcas cara:** particionar `processed_events` por data (apagar vira `DROP PARTITION`).
- **Um consumidor novo com efeito externo:** a idempotência precisa de uma chave aceita pelo sistema externo, não só da
  marca local.

## Evidência

- A mesma mensagem 2 vezes = 1 notificação; 5 entregas simultâneas = 1 `processed` e 4 `duplicate`; efeito que falha
  não deixa a marca: [`notifications-handler.spec.ts`](../../test/integration/notifications-handler.spec.ts).
- Fila de 300 + `kill -9` no meio: 300 de 300 notificações, 0 duplicadas, e 1 `duplicate` reconhecido (a mensagem em
  processamento no crash). [Módulo 13](../modules/13-mensageria-kafka.md), "Resultados obtidos", 13.4.
- Versão antiga depois da nova = `duplicate`; 20 conclusões paralelas sem contagem perdida (**mutação:** com
  ler-somar-gravar, viraram 3): [`reports-handler.spec.ts`](../../test/integration/reports-handler.spec.ts).
- Republicar tudo não dobra nenhum número: [`reports.streaming-spec.ts`](../../test/streaming/reports.streaming-spec.ts).
- Retenção recusada ≤ 7 dias: [`consumer-env.schema.spec.ts`](../../test/unit/consumer-env.schema.spec.ts); limpeza
  em lotes: [`processed-events-cleaner.spec.ts`](../../test/integration/processed-events-cleaner.spec.ts).
