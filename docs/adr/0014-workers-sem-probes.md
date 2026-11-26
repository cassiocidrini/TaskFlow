# ADR-0014: Workers (relay e consumers) sem probes no Kubernetes

- **Status:** Aceito
- **Decisão:** 26/11/2026 (Módulo 02, etapa 2.4) · **Registro:** 26/11/2026
- **Relacionados:** [ADR-0002](0002-transactional-outbox-com-relay-por-polling.md) (o relay) ·
  [ADR-0006](0006-retry-classificado-e-dlt-por-grupo.md) (os consumers) ·
  [Módulo 02](../modules/02-kubernetes.md) · [`k8s/base/workers.yaml`](../../k8s/base/workers.yaml)

## Contexto

Na etapa 2.3, a API ganhou as três probes. Cada uma responde a uma pergunta do orquestrador: a **startup** ("já
subiu?"), a **liveness** ("travou?", e a resposta é reiniciar o container) e a **readiness** ("posso receber
tráfego?", e a resposta é tirar o pod do Service). A medição mostrou que elas são indispensáveis: sem a readiness, um
rollout derrubou 32 requisições.

Na 2.4, os workers chegam ao cluster: o relay da outbox e os consumers `notifications` e `reports`. Eles são
diferentes da API em três pontos:

- **Não recebem tráfego.** Não há Service na frente deles: o relay **busca** trabalho no Postgres, e os consumers
  **buscam** mensagens no Kafka.
- **Não têm servidor HTTP.** Sobem um contexto Nest sem `listen` (`createApplicationContext`). A única porta é a de
  métricas, que no cluster está desligada (`OTEL_SDK_DISABLED`, sem coletor lá dentro).
- **O loop do consumer roda dentro do librdkafka.** O código só é chamado quando chega uma mensagem (`eachMessage`).
  Um consumer ocioso não executa código nosso nenhum, e por isso não há um "progresso" natural para observar.

## Decisão

**Os workers não declaram probes.** Para cada uma, a razão:

| Probe | Por que não |
|---|---|
| **readiness** | Ela decide quem entra num Service. Um worker não está atrás de Service nenhum: não há o que decidir |
| **startup** | Ela só existe para segurar a liveness durante o boot. Sem liveness, ela não tem função |
| **liveness** | Os modos de falha de um worker já têm quem os detecte, e uma rota que só prova que o event loop responde não detecta o que importa (tabela abaixo) |

| Modo de falha | Quem detecta hoje | Uma liveness HTTP ajudaria? |
|---|---|---|
| O processo morre (exceção, OOMKill, erro de boot) | O **kubelet**: container encerrado é reiniciado, com `CrashLoopBackOff` e espera crescente | Não: já resolvido |
| Um consumer trava e para de mandar heartbeat ao Kafka | O **broker**: a sessão expira (30 s, medido no Módulo 13) e as partições vão para outro membro do grupo | Não: o Kafka já tira o membro travado do trabalho |
| O event loop bloqueia por completo | Ninguém, hoje | Sim, mas é o caso raro: um loop síncrono infinito |
| **Um lote preso, uma conexão pendurada, um consumer conectado que não avança** | O **resultado**: o backlog da outbox e o lag do consumer crescem (alertas `OutboxStalled` e `ConsumerLagHigh`, Módulo 13) | **Não:** o event loop continua respondendo, e a probe diria "vivo" |

**O sinal de saúde de um worker é o que ele produz, não se ele responde.** Para o relay, a idade da mensagem mais
antiga na outbox. Para o consumer, o lag do grupo medido pelo broker. Os dois já existem como métricas e alertas
testados com `promtool` ([`prometheus/alerts.yml`](../../prometheus/alerts.yml), Módulo 13).

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Liveness HTTP mínima** (`/health/live` respondendo do event loop) | Código e porta novos em cada worker para detectar só o bloqueio total do event loop, o caso mais raro. E dá uma falsa sensação de cobertura: "o pod está vivo" enquanto a outbox acumula |
| **Heartbeat de progresso** (`/health/live` com 503 se o loop não avança há N segundos) | Detectaria o lote preso no relay, cujo loop de polling tem ritmo próprio (500 ms). No consumer, "progresso" sem mensagens não tem definição: o loop está no librdkafka, e um consumer ocioso e um travado parecem iguais por dentro. E o limite N precisa ser maior que o pior processamento legítimo (retry com backoff, Módulo 13.5), ou a probe mata um consumer saudável no meio de uma mensagem e causa rebalances em cascata |
| **Liveness por `exec`** (um arquivo tocado a cada iteração, conferido pelo kubelet) | O mesmo problema de definir progresso no consumer, e exige diretório gravável (`emptyDir`) num container com disco somente leitura |
| **Readiness só para o rollout andar devagar** | Sem readiness, o pod novo é "pronto" quando o processo inicia, e o rollout de um worker é rápido. Não há tráfego a proteger: o rebalance do grupo é o mesmo com ou sem ela |

## Consequências

**Positivas**
- Nenhum código novo nos workers, nenhuma porta a mais, nenhum risco de uma probe mal calibrada matar um consumer no
  meio de um retry.
- A saúde de um worker é medida onde ela aparece de verdade: no backlog e no lag.

**Negativas**
- **No cluster, hoje, ninguém vê o backlog nem o lag.** Os alertas do Módulo 13 rodam no Prometheus do compose; o
  cluster não tem Prometheus nem `kafka-exporter`. Um relay preso só seria notado por alguém olhando a outbox à mão
  (`SELECT count(*) FROM outbox WHERE published_at IS NULL`). É a lacuna que esta decisão aceita, até a observabilidade
  chegar ao cluster.
- **`1/1 Running` não diz que o worker funciona.** Diz só que o processo está de pé. Na 2.4, quem confirmou que cada
  um estava conectado foram os logs (`Consumer group "notifications" conectado`) e o
  `kafka-consumer-groups.sh --describe`.
- **Um event loop bloqueado por completo não é reiniciado.** No consumer, o broker ainda tira o membro do grupo pela
  sessão, e as partições vão para outro. No relay, a outra réplica continua publicando, porque o advisory lock é por
  lote.

## Revisitar quando

- **A observabilidade chegar ao cluster** (Prometheus e `kafka-exporter`, ou um serviço gerenciado): os alertas de
  backlog e lag passam a cobrir os workers no cluster, e a lacuna acima fecha.
- **Um incidente real de worker travado sem o processo morrer:** é o sinal de que vale o heartbeat de progresso, ao
  menos no relay, onde "progresso" tem definição.
- **Os workers ganharem um servidor HTTP por outro motivo** (métricas no cluster, por exemplo): uma liveness do event
  loop passa a custar quase nada, e o critério muda.

## Evidência

- Os 5 pods dos workers `1/1 Running` sem probe; os logs com `Consumer group ... conectado`; o broker com as 3
  partições divididas entre os 2 membros do `notifications`. [Módulo 02](../modules/02-kubernetes.md), "Resultados", 2.4.
- Kafka fora do ar por escolha (`scale --replicas=0`): os consumers perderam a sessão do grupo
  (`session timed out after 30021 ms`) e entraram de novo sozinhos quando o broker voltou, sem reinício de pod. As
  21 tarefas viraram 21 efeitos em cada consumer.
- Rollout dos consumers no meio de uma rajada de 30 tarefas: 81 eventos, 81 efeitos em cada consumer.
