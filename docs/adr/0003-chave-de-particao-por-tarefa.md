# ADR-0003: Chave de partição = `taskId` (ordem por tarefa)

- **Status:** Aceito
- **Decisão:** 10/11/2026 (Módulo 13.3) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0001](0001-kafka-como-transporte-de-eventos.md) · [ADR-0002](0002-transactional-outbox-com-relay-por-polling.md) ·
  [ADR-0005](0005-idempotencia-no-consumer.md)

## Contexto

No Kafka, a ordem só existe **dentro** de uma partição, e a chave da mensagem decide a partição
(`hash(chave) % nº de partições`). Paralelismo e ordem são, portanto, **a mesma decisão**: o que compartilha a chave é
ordenado e processado em série; o que não compartilha corre em paralelo e sem ordem entre si.

Os consumidores dependem da ordem **dentro de uma tarefa**:
- o `notifications` só sabe a quem avisar do `TaskCompleted` porque viu antes o `TaskCreated` e o `TaskAssigned`;
- o `reports` aplica deltas e guarda a última versão aplicada de cada tarefa.

Nenhum consumidor depende da ordem **entre** tarefas diferentes, nem entre projetos.

## Decisão

A chave de toda mensagem do tópico `taskflow.task-events.v1` é o **`aggregateId`, o `taskId`**. Com 3 partições:

- todos os eventos de uma tarefa caem na mesma partição, na ordem em que foram gravados (a outbox e o relay garantem a
  ordem de saída, [ADR-0002](0002-transactional-outbox-com-relay-por-polling.md));
- tarefas diferentes se espalham pelas 3 partições, e cada consumer group processa até 3 em paralelo.

A chave é definida num lugar só, no mapeamento para a outbox (`task.integration-events.ts`), e não por quem publica.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **`projectId`** | Daria ordem entre as tarefas de um projeto, que ninguém precisa, e criaria **partição quente**: um projeto muito ativo concentraria o tráfego numa partição só, serializando o processamento dele inteiro |
| **`userId` (dono ou responsável)** | O responsável muda durante a vida da tarefa: os eventos de uma mesma tarefa trocariam de partição e perderiam a ordem |
| **Sem chave** (distribuição sem chave pelo cliente) | Melhor espalhamento, nenhuma ordem: o `TaskCompleted` poderia chegar antes do `TaskCreated` |
| **Mais partições desde já** (ex.: 12) | Mais paralelismo possível, mais custo no broker e mais rebalance. 3 bastam para o volume, e mudar depois é um evento planejado (ver "Revisitar quando") |

## Consequências

**Positivas**
- O consumidor pode supor a ordem por tarefa: a projeção local do `notifications` e a guarda de versão do `reports`
  dependem disso.
- Espalhamento bom: há muitas tarefas, e nenhuma gera volume suficiente para esquentar uma partição.

**Negativas**
- **Nada de ordem entre tarefas.** Um relatório por projeto recebe eventos de partições diferentes fora de ordem entre
  si. Por isso o `reports` usa incremento atômico nos contadores e `GREATEST` no "válido até" (`asOf`), e nunca supõe
  que o evento mais novo chegou por último.
- **O paralelismo máximo é 3 por grupo:** uma 4ª réplica de um consumer ficaria ociosa.
- **Mudar o número de partições muda o mapeamento** chave → partição: durante a transição, eventos novos de uma tarefa
  podem ser processados antes dos antigos, que estão em outra partição.

## Revisitar quando

- **Um consumidor precisar de ordem entre as tarefas de um projeto** (uma máquina de estados do projeto, por exemplo):
  aí a chave passa a ser o `projectId`, aceitando o risco de partição quente, ou esse consumidor reordena por conta
  própria.
- **A vazão pedir mais de 3 consumidores por grupo:** criar `taskflow.task-events.v2` com mais partições e migrar os
  grupos (drenar o v1, começar o v2), em vez de aumentar as partições do v1 no lugar.

## Evidência

- Chave = `taskId` no contrato: [`task.integration-events.spec.ts`](../../test/unit/task.integration-events.spec.ts)
  ("chave = taskId") e, pelo repositório real, [`outbox.spec.ts`](../../test/integration/outbox.spec.ts).
- No broker de verdade: cada evento chega com a chave, e os de uma tarefa na mesma partição, em ordem:
  [`outbox-relay.streaming-spec.ts`](../../test/streaming/outbox-relay.streaming-spec.ts).
- Falha com backoff não deixa a mensagem seguinte passar na frente: [`notifications.streaming-spec.ts`](../../test/streaming/notifications.streaming-spec.ts).
- 20 conclusões paralelas no mesmo projeto, vindas de partições diferentes, sem contagem perdida:
  [`reports-handler.spec.ts`](../../test/integration/reports-handler.spec.ts).
- Detalhes: [Módulo 13](../modules/13-mensageria-kafka.md), "Partições: paralelismo e ordem são a mesma decisão".
