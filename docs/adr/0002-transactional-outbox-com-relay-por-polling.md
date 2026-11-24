# ADR-0002: Transactional Outbox, com relay por polling e advisory lock

- **Status:** Aceito
- **Decisão:** 10/11/2026 (Módulos 13.2 e 13.3; ajuste na 13.6b) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0001](0001-kafka-como-transporte-de-eventos.md) · [ADR-0003](0003-chave-de-particao-por-tarefa.md) ·
  [ADR-0005](0005-idempotencia-no-consumer.md) (quem absorve as duplicatas que este desenho produz)

## Contexto

Publicar "logo depois de gravar" são **duas escritas em dois sistemas** sem transação que cubra as duas (*dual-write*):

| Ordem | O que dá errado |
|---|---|
| Grava, depois publica | O processo cai entre o COMMIT e o envio, ou o broker está fora: o evento existe e **nunca é publicado** |
| Publica, depois grava | O INSERT falha (um 409 de concorrência): os consumers recebem um evento que **nunca aconteceu** |
| Retry do envio | Resolve a falha passageira do broker, não o crash do processo: o retry morre junto |

Além disso, os eventos de uma mesma tarefa precisam chegar ao tópico **na ordem em que foram gravados**.

## Decisão

**Outbox na mesma transação.** O `appendMany` do Event Store grava os eventos em `events` **e** o evento de integração
correspondente na tabela `outbox`, numa transação só. A API nunca fala com o Kafka.

**Relay em processo separado**, que publica a outbox:

- mesma imagem, outro comando (`node dist/relay`), Nest sem HTTP (`createApplicationContext`), ambiente próprio sem
  `JWT_SECRET` (menor privilégio);
- **polling**: `WHERE published_at IS NULL ORDER BY id LIMIT 100`, a cada 500 ms com a fila vazia, na hora com lote
  cheio;
- **um lote por vez** em todo o sistema: `pg_try_advisory_xact_lock` na transação da rodada. Réplicas revezam o lock;
- produtor **idempotente** (`acks=all`); `published_at` só é gravado depois do ack de **todas** as mensagens do lote;
- lote que falha volta **inteiro**: nada depois dele sai antes (ordem acima de vazão).

**Ajuste da 13.6b:** com o replay, a outbox ganhou um segundo escritor. Todo escritor pega o lock por agregado
(`lockAggregateForOutbox`) na própria transação, e a ordem por tarefa continua garantida.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Event Store como outbox** (relay lendo `events` com cursor) | Marcar o publicado exigiria `UPDATE` numa tabela append-only; um cursor por tempo ou UUID **pula** eventos que commitam fora de ordem; o formato interno viraria contrato público |
| **CDC (Debezium)** lendo o WAL | O padrão em escala: sem polling, latência de milissegundos. Custa Kafka Connect + Debezium para operar e um slot de replicação para vigiar. A tabela `outbox` continuaria a mesma: o CDC troca só o relay |
| **Transação distribuída (XA/2PC)** | O Kafka não participa de XA; e 2PC acopla a disponibilidade dos dois sistemas |
| **LISTEN/NOTIFY** no lugar do polling | A notificação se perde com o relay fora do ar. Serve **junto** do polling, como otimização de latência |
| **Réplicas em paralelo com `FOR UPDATE SKIP LOCKED`** | O jeito clássico de paralelizar uma fila no Postgres, mas **quebra a ordem por tarefa**: a réplica B pode publicar a v2 antes de a A publicar a v1 |
| **`pg_advisory_lock` de sessão** | O pool do Prisma entrega uma conexão qualquer a cada query: lock e unlock cairiam em conexões diferentes. O de transação vive numa conexão e solta sozinho no COMMIT, no ROLLBACK ou na morte do processo |
| **Relay como `setInterval` dentro da API** | Escalaria com o tráfego HTTP, que não tem relação com o volume de eventos, e disputaria o event loop com as requisições |

## Consequências

**Positivas**
- **Nenhum evento gravado deixa de ser publicado, e nenhum evento publicado deixa de ter sido gravado.**
- A API responde mesmo com o Kafka fora: a outbox acumula e o relay esvazia na volta.
- Failover sem eleição de líder: uma réplica que cai (até com `kill -9`) libera o lock, e a outra segue.

**Negativas**
- **At-least-once:** o relay que cai depois do ack e antes do COMMIT republica o lote, com o mesmo `eventId`. Todo
  consumer precisa ser idempotente ([ADR-0005](0005-idempotencia-no-consumer.md)).
- **Réplicas dão disponibilidade, não vazão:** um lote por vez no sistema todo.
- ***Head-of-line blocking*:** uma mensagem com erro permanente trava a fila. Fica visível no alerta de idade da outbox,
  sem DLQ por decisão ([ADR-0006](0006-retry-classificado-e-dlt-por-grupo.md)).
- **Transação aberta durante o envio** ao Kafka: por isso `message.timeout.ms` de 10 s (o padrão da librdkafka é 5 min)
  e transação de 20 s.
- **Latência de até 500 ms** com a fila vazia, e uma tabela a mais para limpar (publicadas apagadas depois de 72 h).
- O lock por agregado custa uma instrução por gravação da API, mesmo sem replay rodando.

## Revisitar quando

- **A vazão passar do que um relay publica:** particionar a outbox por faixa de `hash(message_key)`, um lock por faixa
  (a mesma ideia das partições do Kafka), ou migrar para CDC.
- **Um requisito de latência abaixo de 500 ms:** LISTEN/NOTIFY junto do polling, ou CDC.
- **Vários serviços com outbox:** o Debezium vira padrão da plataforma, e o relay próprio deixa de compensar.

## Evidência

- Evento e outbox atômicos: conflito de versão deixa **nenhuma** linha em `events` nem em `outbox`; de 10 gravações
  simultâneas na mesma versão, só a vencedora gera mensagem: [`outbox.spec.ts`](../../test/integration/outbox.spec.ts).
- Duas réplicas sobre 200 mensagens: cada uma publicou parte, sem duplicata, ordem por tarefa intacta. **Mutação:**
  trocando o lock por `SELECT true`, as mesmas 200 viram 400 envios: [`outbox-relay.spec.ts`](../../test/integration/outbox-relay.spec.ts).
- Republicação depois de perder o COMMIT sai com o mesmo `event-id`: [`outbox-relay.streaming-spec.ts`](../../test/streaming/outbox-relay.streaming-spec.ts).
- Lock por agregado entre os dois escritores: com o lock de uma tarefa preso, a gravação da API **espera** (e o replay
  dela também), e o lock de uma tarefa não segura outra: [`event-replay.spec.ts`](../../test/integration/event-replay.spec.ts).
- Detalhes: [Módulo 13](../modules/13-mensageria-kafka.md), "Dual-write", "O relay" e "Replay do Event Store".
