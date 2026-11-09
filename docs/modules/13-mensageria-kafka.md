# Módulo 13 — Mensageria e streaming de eventos com Kafka

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 09/11/2026
>
> **Status:** 🚧 em construção, etapa **13.1 de 13.8** (infraestrutura do broker). Cada etapa acrescenta a sua parte
> a este documento; o mapa completo está na seção "Roteiro do módulo", logo abaixo.
>
> **Onde vive no código:** [`docker-compose.yml`](../../docker-compose.yml) (serviços `kafka` e `kafka-init`, profile
> `streaming`) · [`scripts/kafka/smoke.ts`](../../scripts/kafka/smoke.ts)

---

## 🎯 Objetivo

Levar os eventos de tarefa para **fora do processo**, num broker que vários consumidores independentes possam ler,
cada um no seu ritmo, com a possibilidade de **reler o histórico** (*replay*). Tudo isso sem perder a garantia que o
TaskFlow já tem hoje: o que foi gravado no Event Store é o que foi publicado.

**Por que importa:** hoje o `EventBus` é **em memória**. Se o processo cair entre gravar o evento e publicá-lo, a
projeção não é atualizada (o *dual-write* das limitações do [Módulo 05](05-event-sourcing-cqrs.md)). E só quem está
dentro do mesmo processo consegue reagir a um evento. Um sistema de verdade tem outros serviços interessados no mesmo
fato: notificação, relatório, auditoria, antifraude. Cada um precisa receber o evento **pelo menos uma vez**, tratá-lo
**exatamente uma vez** e poder ser reconstruído do zero.

---

## 🗺️ Roteiro do módulo

| Etapa | O que entrega | Status |
|---|---|:-:|
| **13.1** | Broker Kafka 4 (KRaft) no compose, tópico `taskflow.task-events.v1`, smoke test do cliente | ✅ |
| 13.2 | **Transactional Outbox**: o evento de integração gravado na **mesma transação** do Event Store | 🔜 |
| 13.3 | **Relay**: processo *worker* que publica o outbox no Kafka (produtor idempotente, chave = `aggregateId`) | 🔜 |
| 13.4 | Consumer group `notifications` com **idempotência** (`processed_events` na mesma transação do efeito) | 🔜 |
| 13.5 | **Retry com backoff** e **dead-letter topic** | 🔜 |
| 13.6 | Consumer group `reports` (projeção `project_stats`), **replay** e painel de **lag** | 🔜 |
| 13.7 | *(opcional)* Kafka (fato) × **SQS** (trabalho): envio de push por SQS + Lambda | 🔜 |
| 13.8 | ADRs e o diagrama final | 🔜 |

---

## 🏗️ Arquitetura (estado atual: 13.1)

```mermaid
flowchart LR
    subgraph host["Host (sua máquina)"]
        SMOKE["npm run kafka:smoke<br/>(scripts/kafka/smoke.ts)"]
        API["TaskFlow API<br/>(ainda NÃO usa Kafka)"]
    end
    subgraph docker["docker compose --profile streaming"]
        K["kafka :9092 / :29092<br/>broker + controller (KRaft)"]
        INIT["kafka-init<br/>(roda uma vez e sai)"]
    end
    SMOKE -->|"localhost:9092<br/>(listener EXTERNAL)"| K
    INIT -->|"kafka:29092<br/>(listener INTERNAL)"| K
    INIT -.->|"cria"| T1[("taskflow.task-events.v1<br/>3 partições · 7 dias")]
    INIT -.->|"cria"| T2[("taskflow.smoke<br/>1 partição · 1 hora")]
```

Ao fim do módulo, o desenho será: `API → (mesma transação) events + outbox → relay → Kafka → consumer groups`.

---

## 🧠 Conceitos

### O vocabulário, com um paralelo para quem vem de SQS/SNS

| Kafka | O que é | Paralelo AWS (aproximado) |
|---|---|---|
| **Broker** | Servidor que guarda e serve as mensagens | O serviço SQS/SNS em si |
| **Tópico** | Nome lógico de um fluxo de mensagens | Um tópico SNS |
| **Partição** | Pedaço do tópico: um **log append-only e ordenado**. Unidade de paralelismo **e** de ordem | Um *message group* de uma fila SQS FIFO |
| **Offset** | Posição de uma mensagem dentro da partição (0, 1, 2…) | Não existe: o SQS apaga a mensagem ao processá-la |
| **Chave (*key*)** | Define a partição: mesma chave → mesma partição → **mesma ordem** | `MessageGroupId` do SQS FIFO |
| **Consumer group** | Conjunto de consumidores que **dividem** as partições de um tópico; cada grupo lê **tudo**, independente dos outros | Cada fila SQS assinando o mesmo tópico SNS (*fan-out*) |
| **Offset commitado** | "Até onde este grupo já processou", guardado pelo próprio Kafka | O *delete* da mensagem no SQS |
| **Lag** | Mensagens ainda não processadas por um grupo (`log-end-offset − offset commitado`) | `ApproximateNumberOfMessagesVisible` |
| **Retenção** | Por quanto tempo o log é guardado, **processado ou não** | Retenção da fila (só até ser consumida, no máx. 14 dias) |

**A diferença que muda o desenho:** no SQS, consumir **apaga**. No Kafka, consumir só **move o offset do grupo**;
a mensagem continua no log até a retenção vencer. Por isso, no Kafka:

- um consumidor novo pode ler o histórico desde o início (`fromBeginning`);
- um consumidor com bug pode **voltar o offset** e reprocessar (*replay*, etapa 13.6);
- vários grupos leem o mesmo fato sem que o broker precise copiar a mensagem para cada um.

### Partições: paralelismo e ordem são a mesma decisão

- A ordem só é garantida **dentro** de uma partição. Entre partições, não há ordem.
- A chave decide a partição (`hash(chave) % nº de partições`). No TaskFlow a chave será o `aggregateId` (etapa 13.3):
  todos os eventos de **uma tarefa** caem na mesma partição, em ordem. Tarefas diferentes se espalham pelas 3.
- Num consumer group, cada partição é lida por **no máximo um** consumidor do grupo. Com 3 partições, até 3
  consumidores trabalham em paralelo; um 4º ficaria ocioso.
- Aumentar partições depois **muda o mapeamento chave → partição** e quebra a ordem durante a transição. Por isso o
  número entra no contrato do tópico desde o início.

### KRaft (sem ZooKeeper)

Até o Kafka 3.x, os metadados do cluster (quais tópicos existem, quem é líder de cada partição) ficavam num
ZooKeeper separado. No **KRaft**, um quórum de *controllers* do próprio Kafka guarda esses metadados num log Raft.
O Kafka 4 **só** funciona assim. Aqui, o único nó é **broker e controller** ao mesmo tempo (`KAFKA_PROCESS_ROLES:
broker,controller`); em produção, os controllers costumam ficar em nós dedicados (3, para tolerar a perda de 1).

### Replicação, ISR e `acks` (o que este ambiente NÃO tem)

Em produção, cada partição tem réplicas em brokers diferentes (fator de replicação **3**). O **ISR** (*in-sync
replicas*) é o conjunto de réplicas em dia com o líder. Com `acks=all` no produtor e `min.insync.replicas=2` no
tópico, uma escrita só é confirmada quando **2 réplicas** a têm: um broker pode morrer sem perder mensagem
confirmada. Com **1 nó** isso é impossível (RF 1), e este ambiente existe para desenvolvimento.

### Por que Kafka (e não SNS+SQS ou Redpanda) neste projeto

| Opção | A favor | Contra | Decisão |
|---|---|---|---|
| **Kafka** | Log retido e **relível** (replay); ordem por chave; vários grupos lendo o mesmo fato; padrão de mercado para *event streaming* | Operar um cluster (aqui, só 1 nó local) | ✅ **Escolhido**: o módulo existe para cobrir event streaming com replay |
| **SNS + SQS** | Gerenciado na AWS, zero operação; DLQ nativa; ótimo para **distribuir trabalho** | Sem replay (consumir apaga); ordem só com FIFO e com limite de vazão | Fica para o que ele faz melhor: **fila de trabalho** (etapa 13.7) |
| **Redpanda** | Mesmo protocolo do Kafka, um binário só, menos memória | Menos comum em vaga; o objetivo é o Kafka em si | Plano B se faltar RAM: o código não mudaria |

O critério que vai para o ADR (13.8): **Kafka para fatos** (algo aconteceu, e quem quiser reage, inclusive no
futuro); **SQS para trabalho** (alguém precisa fazer isto uma vez).

---

## 📋 Como reproduzir

### 1. Subir o broker

```bash
npm run streaming:up      # sobe o kafka (espera o healthcheck) e roda o kafka-init (cria os tópicos)
npm run streaming:topics  # descreve os tópicos
npm run streaming:down    # para e remove SÓ o container do kafka; o volume kafka_data (o log) continua
```

`npm run dev` e os testes **não** sobem o Kafka: ele está no profile `streaming` do compose. Quem não está
trabalhando com mensageria não paga ~300 MB de RAM nem os ~15 s de boot.

### 2. As decisões do `docker-compose.yml`

| Configuração | Valor | Por quê |
|---|---|---|
| Imagem | `apache/kafka:4.3.2` | Imagem oficial; versão fixa, como todo o compose. Patch maduro da linha 4.3 em vez do `4.4.0`, recém-saído na época |
| `KAFKA_PROCESS_ROLES` | `broker,controller` | KRaft com 1 nó |
| **Listeners** | `EXTERNAL://localhost:9092` (host) e `INTERNAL://kafka:29092` (containers) | Ver "Os dois listeners" abaixo |
| `KAFKA_AUTO_CREATE_TOPICS_ENABLE` | `false` | Tópico é **contrato**: com autocriação, um nome digitado errado no produtor cria outro tópico e o consumidor espera no certo, em silêncio |
| Replicação dos tópicos internos | `1` | Só há 1 broker. Em produção: 3 |
| `KAFKA_HEAP_OPTS` | `-Xms384m -Xmx384m` | O padrão da imagem reserva 1 GB |
| Volume `kafka_data` | `/var/lib/kafka/data` | O log sobrevive a `streaming:down`/`up` (verificado: offsets mantidos) |
| Healthcheck | `kafka-broker-api-versions.sh` | "Container de pé" não é "broker aceitando clientes" |

**Os dois listeners.** O cliente faz a 1ª conexão no endereço que você configurou (*bootstrap*), mas depois usa o
endereço que o **broker anuncia**. Se o broker anunciasse `kafka:29092`, a API rodando no host não resolveria esse
nome; se anunciasse `localhost:9092`, um container receberia "localhost", que dentro dele é o próprio container. Daí
um listener por "lugar de onde o cliente vem". É o erro número 1 de quem sobe Kafka em Docker.

### 3. O contrato do tópico (`kafka-init`)

```bash
kafka-topics.sh --create --if-not-exists --topic taskflow.task-events.v1 \
  --partitions 3 --replication-factor 1 --config retention.ms=604800000 --config cleanup.policy=delete
```

| Item | Valor | Por quê |
|---|---|---|
| Nome | `taskflow.task-events.v1` | `<sistema>.<assunto>.<versão>`. Uma mudança **incompatível** vira `v2`, publicada em paralelo enquanto os consumidores migram. Só `.` e `-`, nunca `_`: o Kafka troca `.` por `_` nos nomes de métrica, e misturar os dois pode colidir |
| Partições | 3 | Até 3 consumidores em paralelo por grupo; ordem garantida por tarefa (chave) |
| Retenção | 7 dias, `delete` | O Kafka **não** é a fonte da verdade, o Event Store é. Reconstruir uma projeção nova do zero = republicar a partir da tabela `events`, não depender do tópico guardar tudo para sempre |
| `--if-not-exists` | — | Idempotente: `streaming:up` pode rodar quantas vezes quiser |

Existe também o tópico `taskflow.smoke` (1 partição, 1 hora), só para o smoke test: mensagem de teste nunca vai
para o tópico de eventos, que os consumers reais vão ler.

### 4. Smoke test do cliente

```bash
npm run kafka:smoke
# [OK] taskflow.task-events.v1: 3 partições
# [OK] produzida em taskflow.smoke (partição 0, offset 1)
# [OK] consumida pelo grupo taskflow.smoke (partição 0, offset 1)
# [OK] Kafka respondendo em localhost:9092 — ida e volta em 336 ms
```

O que ele prova ([`smoke.ts`](../../scripts/kafka/smoke.ts)): o cliente instala e carrega o binding nativo, o
tópico de eventos tem o contrato esperado, e uma mensagem faz a ida e volta (producer idempotente → consumer group)
com chave, valor e header intactos.

**Cliente: `@confluentinc/kafka-javascript`.** O KafkaJS, que foi o cliente Node mais popular, está sem manutenção.
O cliente da Confluent embute a **librdkafka** (o mesmo núcleo em C dos clientes oficiais de Go, Python e .NET) e
oferece uma API compatível com KafkaJS (`KafkaJS.Kafka`), que é a usada aqui.

### 5. Ferramentas de linha de comando (dentro do container)

```bash
K="docker compose --profile streaming exec kafka /opt/kafka/bin"

$K/kafka-topics.sh --bootstrap-server localhost:9092 --list
$K/kafka-get-offsets.sh --bootstrap-server localhost:9092 --topic taskflow.smoke          # ponta do log por partição
$K/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group taskflow.smoke   # offset e LAG
$K/kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic taskflow.smoke --from-beginning \
  --property print.key=true --property print.headers=true
```

Exemplo real do `--describe` depois de duas execuções do smoke test:

```text
GROUP           TOPIC           PARTITION  CURRENT-OFFSET  LOG-END-OFFSET  LAG
taskflow.smoke  taskflow.smoke  0          2               2               0
```

`CURRENT-OFFSET = 2` com a última mensagem no offset 1: o offset commitado é o **próximo a ler**, não o último lido.

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | Aviso `topics with a period ('.') or underscore ('_') could collide` ao criar o tópico | O Kafka troca `.` por `_` nos nomes de métrica; dois tópicos que só diferem nisso colidiriam | Convenção: só `.` e `-` nos nomes. O aviso aparece para qualquer nome com `.`, e é esperado |
| 2 | npm 11 avisa que o pacote tem script de instalação "não coberto por `allowScripts`" | O cliente baixa o **binário pré-compilado** da librdkafka das *releases* do GitHub no `install` (`node-pre-gyp`) | Hoje o npm só avisa e o binário é baixado. Fica registrado: o `npm ci` do CI precisa de acesso ao GitHub, e é uma dependência de cadeia de suprimentos a acompanhar |
| 3 | `Failed to acquire idempotence PID … Coordinator load in progress: retrying` no 1º produtor | Logo após o boot, o coordenador de transações ainda está carregando; o produtor **idempotente** precisa dele para obter um *producer id* | Benigno: o cliente tenta de novo sozinho, e a mensagem foi entregue. Só acontece no primeiro produtor depois do boot |
| 4 | 1ª execução do smoke em 3,8 s; a 2ª em 336 ms | O *join* de um consumer group novo (descoberta do coordenador, rebalance, atribuição) levou ~2,9 s | Esperado, e documentado. Num consumer de longa duração isso acontece uma vez, na subida |
| 5 | O cliente imprimia cada conexão e rebalance como um objeto no console | O `logLevel` padrão do cliente é INFO | `logLevel: KafkaJS.logLevel.WARN` |

---

## 📊 Resultados obtidos (13.1)

| Medida | Valor |
|---|---|
| `npm run streaming:up` (do zero até o tópico criado) | ~16 s |
| Memória do container `kafka` em repouso | ~280 MiB (heap limitado a 384 MiB) |
| Smoke test, 1ª execução (grupo novo) | 3,8 s, dos quais ~2,9 s no join do grupo |
| Smoke test, execuções seguintes | 336 ms a 864 ms |
| Persistência | Após `streaming:down` + `streaming:up`, tópicos e offsets mantidos |

---

## 🔄 Como este módulo evoluiu com o projeto

| Antes | Hoje (13.1) | Por quê |
|---|---|---|
| `EventBus` em memória como único meio de entregar eventos | Broker Kafka disponível no compose, ainda **não** usado pela API | A infraestrutura entra e é validada antes do código que depende dela |
| SQS/SNS provisionados no Terraform e sem uso | Inalterado | O papel do SQS (fila de trabalho) entra na etapa 13.7 |

---

## 🚧 Limitações e próximos passos

- **A API ainda não publica nada no Kafka.** Os eventos continuam indo só para o `EventBus` em memória. O caminho
  confiável (outbox + relay) é o objetivo das etapas 13.2 e 13.3.
- **Um nó só:** RF 1, sem ISR; perder o broker é perder o log. É ambiente de desenvolvimento.
- **Sem segurança no broker:** `PLAINTEXT`, sem TLS nem SASL. Em produção: TLS + autenticação (SASL/SCRAM ou mTLS)
  e ACL por tópico e grupo.
- **Sem schema registry:** o formato da mensagem será um contrato TypeScript versionado no código (13.2). Um registry
  (Avro/Protobuf) valida a compatibilidade no próprio broker.
- **Tópicos criados pelo compose:** em produção, o contrato do tópico ficaria em IaC (ex.: provider Kafka do
  Terraform), revisado em PR como o resto da infraestrutura.

---

## ✅ Checklist

- [x] Kafka 4 em KRaft no compose (profile `streaming`), com healthcheck e volume
- [x] Listeners separados para host e containers
- [x] Tópico de eventos criado explicitamente (sem autocriação), com partições e retenção no contrato
- [x] Smoke test do cliente (admin, producer idempotente, consumer group)
- [ ] Transactional Outbox (13.2)
- [ ] Relay para o Kafka (13.3)
- [ ] Consumer idempotente (13.4)
- [ ] Retry e dead-letter topic (13.5)
- [ ] Replay e painel de lag (13.6)
- [ ] Kafka × SQS no mesmo sistema (13.7, opcional)
- [ ] ADRs (13.8)

---

**Anterior:** [Módulo 12 — Design Patterns](12-design-patterns.md) ·
**Índice:** [Trilha de estudos](README.md)
