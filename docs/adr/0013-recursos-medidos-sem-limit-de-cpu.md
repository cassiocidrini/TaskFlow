# ADR-0013: Recursos dos pods: requests medidos, limit de memória e sem limit de CPU

- **Status:** Aceito
- **Decisão:** 26/11/2026 (Módulo 02, etapa 2.3) · **Registro:** 26/11/2026
- **Relacionados:** [Módulo 02](../modules/02-kubernetes.md#recursos-medir-antes-de-declarar-23) (a medição) ·
  [`k8s/base/api.yaml`](../../k8s/base/api.yaml) · [Módulo 10](../modules/10-performance-load-testing.md) (bcrypt no thread pool)

## Contexto

Até a 2.2, os pods do TaskFlow no cluster não declaravam `resources`. Para o Kubernetes, isso significa a classe de
QoS `BestEffort`: o scheduler põe o pod em qualquer nó sem reservar nada, e numa falta de memória ele é o **primeiro**
a ser despejado. Um processo com vazamento de memória também poderia esgotar o nó e levar os vizinhos junto.

Declarar `resources` envolve duas escolhas com efeitos diferentes:

- O **request** é o que o scheduler **reserva**: decide em qual nó o pod cabe, e garante a fatia dele quando há
  disputa por CPU (o *cgroup* distribui CPU por peso, proporcional ao request).
- O **limit** é o teto, e se comporta de jeitos diferentes por recurso. Memória passou do limit: o kernel mata o
  processo (`OOMKilled`), e o kubelet reinicia o container. CPU passou do limit: o kernel **pausa** o processo até a
  próxima janela de 100 ms (*CFS throttling*), **mesmo com o nó ocioso**.

A API é Node: um event loop e um thread pool de 4 threads (libuv). Rotas com bcrypt (cadastro e login) ocupam esse
pool e consomem mais de um núcleo em rajadas curtas. Um limit de CPU baixo transformaria essas rajadas em pausas, e as
pausas em latência de cauda (p99).

## Decisão

**Os valores vêm de medição, não de chute.** O consumo foi lido do cgroup do container (`memory.current`,
`memory.peak` e `cpu.stat`), com `kubectl exec`, antes e depois de 90 s de carga dentro do cluster.

| Pod | `requests.cpu` | `requests.memory` | `limits.memory` | `limits.cpu` |
|---|---|---|---|---|
| API | `100m` (medido: ~0,04 núcleo a ~97 req/s) | `192Mi` (pico do boot: 183 MiB) | `384Mi` (2× o pico) | **nenhum** |
| Job de migração | `100m` | `128Mi` | `256Mi` | **nenhum** |
| Postgres | `100m` | `256Mi` (o `shared_buffers` padrão é 128 MB) | `512Mi` | **nenhum** |

- **Memória sempre com limit.** Ela não é comprimível: sem teto, um vazamento esgota o nó. Com teto, quem morre é o
  próprio pod, com o motivo visível (`OOMKilled` no `kubectl describe`), e o kubelet o reinicia.
- **CPU sem limit.** Ela é comprimível: a falta vira lentidão, não morte. O **request** já garante a fatia justa de cada
  pod quando o nó está disputado; quando o nó tem CPU sobrando, o pod usa a sobra em vez de ser pausado.
- **O request de memória cobre o pico do boot**, não a média: reservar menos deixaria o scheduler colocar no nó mais
  pods do que cabem no momento em que eles sobem juntos (um rollout, um nó que voltou).

Com request de memória menor que o limit, os pods ficam na classe de QoS `Burstable`.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Sem `resources`** (o estado da 2.2) | QoS `BestEffort`: primeiro a ser despejado, sem reserva no scheduler e sem teto para um vazamento |
| **Limit de CPU = 2× o request** (o padrão de muitos templates) | *Throttling* em toda rajada de bcrypt, mesmo com o nó ocioso: o p99 piora sem nenhum sinal óbvio no painel de CPU, que mostra uso baixo na média |
| **Requests = limits, para os dois recursos** (QoS `Guaranteed`) | A classe mais protegida contra despejo, mas paga o pico o tempo todo (a reserva de 384Mi por pod que usa ~110 MiB) e mantém o *throttling* de CPU. Faz sentido para banco crítico ou para cargas que exigem núcleo dedicado (*CPU manager* `static`) |
| **`LimitRange` com padrões no namespace** | Útil como rede de segurança para quem esquecer de declarar, mas aplica o mesmo número a pods diferentes; o valor certo é por carga, e todo pod daqui declara o seu |
| **VPA (Vertical Pod Autoscaler) desde já** | O caminho certo para ajustar com dados de produção (em modo de recomendação), mas não há tráfego real num cluster local para ele aprender |

## Consequências

**Positivas**
- O scheduler passa a decidir com números reais, e um vazamento de memória mata só o próprio pod, com motivo.
- Sem *throttling*: as rajadas de bcrypt usam a CPU ociosa do nó, em vez de esperar a próxima janela de 100 ms.
- A base para o HPA (2.5): a utilização de CPU que ele mede é relativa ao **request**, que agora existe.

**Negativas**
- **QoS `Burstable`:** sob pressão de memória no nó, estes pods são despejados antes dos `Guaranteed`.
- **Sem teto de CPU, um pod com loop infinito consome a sobra do nó.** Os vizinhos continuam com a fatia garantida
  pelos requests deles, mas perdem a sobra que usariam. A liveness (10 s × 3) reinicia o pod se o loop travar o event
  loop a ponto de o `/health/live` não responder.
- **Medido com o caminho mais barato:** o `/health/live` não toca o banco nem o bcrypt. O limit de 384Mi tem folga
  pensada para isso, mas não foi provado com as rotas caras.
- **No kind, os requests não protegem nada de verdade:** os três nós dizem ter 16 CPUs e 32 GiB cada, mas são
  containers na mesma máquina. A decisão vale para um cluster real; a medição é local.

## Revisitar quando

- **Houver métricas de produção:** os requests passam a vir do p95 de uso real por pod (ou de um VPA em modo de
  recomendação), e não de um teste local.
- **Um `ResourceQuota` do cluster exigir `limits.cpu`:** com quota de CPU por limit, o API server recusa pod sem
  limit; aí entra um limit alto (bem acima das rajadas), para cumprir a quota sem causar *throttling*.
- **O cluster for compartilhado com outros times** e um vizinho barulhento sem limit virar problema: um `LimitRange`
  com limit de CPU padrão, aplicado ao namespace dos outros.
- **Aparecer `OOMKilled` no `describe`:** é sinal de que o limit de memória ficou curto para uma rota que a medição
  não cobriu.

## Evidência

- A medição, por pod: `memory.peak` 183 MiB (boot); `memory.current` de ~94 MiB para ~114 MiB sob carga;
  `usage_usec` +4,06 s e +3,06 s de CPU em ~95 s (~0,04 núcleo); Postgres com 26 MiB (pico de 34 MiB).
  [Módulo 02](../modules/02-kubernetes.md), "Resultados", 2.3.
- Com os recursos aplicados, o rollout sob carga teve 0 falhas em 17.610 requisições, e nenhum pod reiniciou.
