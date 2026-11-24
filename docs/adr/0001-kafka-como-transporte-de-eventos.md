# ADR-0001: Kafka (KRaft) como transporte dos eventos de integração

- **Status:** Aceito
- **Decisão:** 09/11/2026 (Módulo 13.1) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0002](0002-transactional-outbox-com-relay-por-polling.md) (como os eventos chegam ao broker) ·
  [ADR-0007](0007-kafka-para-fatos-sqs-para-trabalho.md) (onde o SQS entra)

## Contexto

Os eventos de tarefa só existiam dentro do processo da API: o `EventBus` do `@nestjs/cqrs` é **em memória**. Quem
quisesse reagir a uma tarefa concluída (notificação, relatório, auditoria) precisava estar no mesmo processo, e um
read model perdido não tinha de onde ser reconstruído além do Event Store.

O que o transporte precisava oferecer:

1. **Vários consumidores independentes do mesmo fato**, cada um no seu ritmo, sem um esperar o outro.
2. **Reler o histórico** (*replay*): um consumidor novo, ou um com bug corrigido, reprocessa o que já passou.
3. **Ordem por tarefa:** o `TaskCompleted` não pode chegar antes do `TaskCreated` da mesma tarefa.
4. Rodar **localmente**, num laptop de desenvolvimento, com pouca memória.

## Decisão

Usamos **Apache Kafka 4** em modo **KRaft** (sem ZooKeeper) como transporte dos eventos de integração:

- imagem `apache/kafka:4.3.2` (um patch maduro da 4.3, e não a 4.4 recém-lançada), um nó que é broker e controller,
  heap limitado a 384 MB, no profile `streaming` do compose (fora do `npm run dev`);
- tópico `taskflow.task-events.v1`, **3 partições**, **retenção de 7 dias**. O Event Store continua sendo a fonte da
  verdade: o histórico completo volta ao tópico pelo replay (13.6b);
- `auto.create.topics.enable=false`: todo tópico é criado pelo `kafka-init`, com partições e retenção explícitas
  (é o contrato do tópico, revisado em PR);
- cliente `@confluentinc/kafka-javascript` (librdkafka por baixo), e não o KafkaJS, que está sem manutenção.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **SNS + SQS** | Zero operação e DLQ nativa, mas **consumir apaga**: não há replay, e um consumidor novo não vê o passado. Ordem só com FIFO, com limite de vazão. Ficou para o que faz melhor: fila de trabalho ([ADR-0007](0007-kafka-para-fatos-sqs-para-trabalho.md)) |
| **Kinesis Data Streams** | O equivalente gerenciado da AWS (shards, ordem por chave, retenção, releitura). Recusado porque o objetivo do módulo é o ecossistema Kafka (consumer groups, offsets, ferramentas), que também roda gerenciado (MSK, Confluent Cloud) |
| **Amazon EventBridge** | Roteamento por regras e gerenciado, mas sem ordem por chave e sem offset por consumidor: um consumidor não "volta no tempo" sozinho |
| **Redpanda** | Mesmo protocolo do Kafka, um binário, menos memória. Ficou como **plano B** se faltasse RAM: o código não mudaria |
| **Continuar só com o `EventBus`** | Não atende 1 nem 2; e o dual-write entre gravar e publicar continuaria |

## Consequências

**Positivas**
- *Fan-out* sem cópia: cada consumer group lê o mesmo log com o seu offset. O segundo grupo (`reports`, 13.6a) entrou
  sem mudar uma linha do produtor.
- Replay por offset (dentro dos 7 dias) e pelo Event Store (além deles).
- Ordem por chave dentro da partição ([ADR-0003](0003-chave-de-particao-por-tarefa.md)).

**Negativas**
- **Um sistema a mais para operar**: tópicos, retenção, lag, rebalance. Em produção, 3 brokers e 3 controllers no
  mínimo, ou um serviço gerenciado.
- **Um nó só em desenvolvimento:** fator de replicação 1, sem ISR; perder o broker é perder o log. Aceitável porque o
  Event Store é a fonte da verdade.
- **Sem segurança no broker** (`PLAINTEXT`). Produção exige TLS, SASL e ACL por tópico e grupo.
- **Sem schema registry:** o contrato é TypeScript versionado ([ADR-0004](0004-evento-de-integracao-separado-do-dominio.md)).
- O número de partições é difícil de mudar depois: aumentar muda o mapeamento chave → partição.

## Revisitar quando

- O sistema for **todo AWS serverless** e o volume continuar baixo: Kinesis ou EventBridge eliminariam o custo de
  operar um cluster.
- **Nenhum consumidor precisar de replay nem de ordem**: SNS + SQS seria mais simples.
- O custo de operação pesar: MSK Serverless ou Confluent Cloud, mantendo o código (mesmo protocolo).
- A vazão exigir mais de 3 consumidores em paralelo por grupo: replanejar as partições antes (novo tópico `.v2`).

## Evidência

- Smoke test do cliente (admin, produtor idempotente, consumer group): [`scripts/kafka/smoke.ts`](../../scripts/kafka/smoke.ts).
- Suíte de streaming com Kafka e Postgres reais no CI (4º job obrigatório): [`test/streaming/`](../../test/streaming/).
- Dois grupos no mesmo tópico, cada um com offset e lag próprios: [`reports.streaming-spec.ts`](../../test/streaming/reports.streaming-spec.ts).
- Detalhes e medições: [Módulo 13](../modules/13-mensageria-kafka.md), "Por que Kafka (e não SNS+SQS ou Redpanda)".
