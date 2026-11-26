# Módulo 02 — Orquestração com Kubernetes

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 26/11/2026
>
> **Status:** 🚧 em construção, etapa **2.3 de 2.6** (a API troca de versão sob carga sem perder requisição, medido:
> 32 falhas → 0; com probes, recursos medidos e `securityContext`). Cada etapa acrescenta a sua parte a este documento; o mapa completo está em "Roteiro do módulo".
>
> **Onde vive no código:** [`k8s/kind-config.yaml`](../../k8s/kind-config.yaml) (o cluster) ·
> [`k8s/base/`](../../k8s/base/api.yaml) (API e Service) · [`postgres.yaml`](../../k8s/base/postgres.yaml) ·
> [`config.yaml`](../../k8s/base/config.yaml) · [`migrate-job.yaml`](../../k8s/base/migrate-job.yaml) ·
> [`k8s/load/k6-rollout.yaml`](../../k8s/load/k6-rollout.yaml) (a carga durante o rollout) ·
> [`k8s-api-manifest.spec.ts`](../../test/unit/k8s-api-manifest.spec.ts) · a imagem que o cluster roda vem do workflow
> [`publish-image.yml`](../../.github/workflows/publish-image.yml) ([Módulo 03](03-ci-cd-github-actions.md), E.3)

---

## 🎯 Objetivo

O pipeline termina numa imagem testada, atestada e publicada por digest (Módulo 03). Falta quem a **rode** em
produção, respondendo o que um `docker run` numa máquina não responde:

1. Quantas cópias rodam, e quem sobe outra quando uma cai (ou quando a máquina cai)?
2. Como trocar a versão sem derrubar as requisições em andamento?
3. Para onde mandar o tráfego, e só quando a cópia nova estiver pronta?
4. Como a migração do banco roda uma vez, antes da API nova?

O Kubernetes é um **orquestrador**: declara-se o estado desejado ("2 cópias desta imagem, com estas probes"), e ele
trabalha continuamente para que o real fique igual ao declarado.

**Por que importa:** muito do que o projeto já tem foi feito para isto, e só aqui vira comportamento:

| O que já existe | Onde vira peça no Kubernetes |
|---|---|
| `/health/live` e `/health/ready` ([Módulo 01](01-observabilidade.md)) | *liveness* e *readiness probes* (2.3) |
| Graceful shutdown com drenagem (Módulo 01) | Rolling update sem perder requisição (2.3) |
| Imagem não-root, `USER 1000:1000` numérico (Módulo 03, E.1/E.2) | `runAsNonRoot: true` conferível (2.3) |
| Target `migrate` separado (E.1) | Um **Job** que roda antes da API (2.2) |
| Imagem publicada por digest (E.3) | O manifesto referencia o digest, nunca uma tag (2.1) |
| Configuração só por variável de ambiente (12-Factor) | ConfigMap e Secret (2.2) |

---

## 🗺️ Roteiro do módulo

| Etapa | O que entrega | Status |
|---|---|:-:|
| **2.1** | Cluster local com **kind** (1 control-plane + 2 workers, versão fixada por digest), `kubectl`, e o primeiro Deployment da API, que falha de propósito: o diagnóstico de um `CrashLoopBackOff` e a reconciliação observada | ✅ |
| **2.2** | Postgres no cluster (StatefulSet + volume persistente), ConfigMap e Secret (fora do Git), a **migração como Job**, e a API respondendo por um Service | ✅ |
| **2.3** | A API de verdade: probes, recursos medidos, `securityContext` e Pod Security, **rolling update sob carga sem erro** (medido antes e depois) e rollback | ✅ |
| 2.4 | Kafka, relay e consumers no cluster | 🔜 |
| 2.5 | Ingress, escala automática (HPA) e NetworkPolicy | 🔜 |
| 2.6 | Ambientes com Kustomize (dev × prod) e a segunda metade do CD (GitOps) | 🔜 |

---

## 🏗️ Arquitetura (estado atual: 2.3)

```text
sua máquina
  ├─ kubectl ──HTTPS──► 127.0.0.1:<porta>  (a API do cluster, publicada pelo kind; credencial em ~/.kube/config)
  ├─ kubectl port-forward svc/taskflow-api 8080:80 ──► (túnel pela API do cluster, para testar)
  │
  └─ Docker
       ├─ compose: postgres, kafka, jaeger, prometheus, grafana, localstack   (ambiente de dev, sem relação com o cluster)
       └─ rede "kind" (172.19.0.0/16)
            ├─ taskflow-control-plane  ── apiserver · etcd · scheduler · controller-manager · coredns
            │                             (taint control-plane:NoSchedule: não recebe os pods da aplicação)
            ├─ taskflow-worker   ──┐
            └─ taskflow-worker2  ──┴─ kubelet + containerd · kube-proxy · kindnet (rede dos pods, 10.244.0.0/16)

namespace taskflow   (Pod Security: enforce baseline · warn/audit restricted)
  ConfigMap taskflow-api (NODE_ENV, LOG_LEVEL, OTEL_SDK_DISABLED, SHUTDOWN_DRAIN_MS=5000, SHUTDOWN_TIMEOUT_MS=20000)  ← Git
  Secret taskflow-db (password) · Secret taskflow-api (jwt-secret)       ← kubectl create, NUNCA no Git
       │
       ├─► Service postgres (headless) ─► StatefulSet postgres ─► postgres-0 ─► PVC data-postgres-0 (1 GiB) ─► PV (local-path)
       │                                    readiness: pg_isready
       ├─► Job taskflow-migrate-aa4d4a0 ─► prisma migrate deploy (20 migrações) ─► Complete     (1º, com kubectl wait)
       └─► Service taskflow-api (ClusterIP :80) ─► EndpointSlice (IPs dos pods prontos)
                                                  └─► Deployment taskflow-api ─► ReplicaSet ─► 2 pods (um por worker)
                                                        imagem ghcr.io/cassiocidrini/taskflow@sha256:41e6c0e0… (aa4d4a0)
                                                        DATABASE_URL = postgresql://taskflow:$(POSTGRES_PASSWORD)@postgres:5432/taskflow
                                                        startup/liveness: /health/live · readiness: /health/ready
                                                        rolling update maxSurge 1 / maxUnavailable 0 · grace 30 s
                                                        uid 1000, disco somente leitura, sem capabilities, seccomp
                                                        requests 100m / 192Mi · limit 384Mi (sem limit de CPU)

  Job k6-rollout (k8s/load, só para medir) ─► GET http://taskflow-api/health/live, ~195 req/s, durante o rollout
```

---

## 🧠 Conceitos

### Declarativo e reconciliação: a ideia central

Num modelo **imperativo**, você dá ordens: "suba um container", "suba outro". Se um cair, ninguém sabe que eram
dois. No **declarativo**, você grava o **estado desejado** ("2 réplicas desta imagem") na API, e componentes
independentes (os *controllers*) ficam num laço: **observar** o estado real, **comparar** com o desejado e **agir**
para aproximar os dois. Esse laço é a **reconciliação**, e tudo no Kubernetes funciona assim.

Os eventos da criação do nosso Deployment mostram a corrente, sem ninguém dar ordem a ninguém:

```text
deployment/taskflow-api   ScalingReplicaSet   o controller de Deployment criou um ReplicaSet com 2 réplicas
replicaset/…-7c6999f7c    SuccessfulCreate×2  o controller de ReplicaSet criou 2 pods (ainda sem nó)
pod/…                     Scheduled           o scheduler escolheu um worker para cada um
pod/…                     Pulling → Pulled    o kubelet do nó baixou a imagem (10,8 s, 131 MB) e a rodou
```

### Os componentes

| Peça | Onde | O que faz |
|---|---|---|
| `kube-apiserver` | control-plane | A **única** porta de entrada: todo `kubectl`, todo controller e todo kubelet falam com ela |
| `etcd` | control-plane | O banco chave-valor com **todo** o estado do cluster (o desejado e o observado) |
| `kube-scheduler` | control-plane | Decide **em qual nó** cada pod novo roda |
| `kube-controller-manager` | control-plane | Os laços de reconciliação (Deployment, ReplicaSet, nós, Jobs…) |
| `kubelet` + `containerd` | cada nó | Roda os containers dos pods daquele nó e informa o estado à API |
| `kube-proxy` | cada nó (DaemonSet) | Regras de rede que fazem um *Service* chegar aos pods (2.2) |
| `coredns` | qualquer nó | DNS interno: o nome de um Service vira IP (2.2) |
| `kindnet` | cada nó (DaemonSet) | A rede entre os pods (o CNI do kind) |

**DaemonSet** é o "uma cópia em cada nó": o `kube-proxy` e o `kindnet` aparecem exatamente uma vez por máquina.

### Pod, ReplicaSet, Deployment: por que três camadas

| Objeto | Responsabilidade | Por que não basta |
|---|---|---|
| **Pod** | Um ou mais containers que nascem e morrem juntos, com um IP | Se morre ou o nó cai, **ninguém o recria** |
| **ReplicaSet** | Manter **N** pods iguais vivos (recria os que somem) | Não sabe trocar de versão: um template novo exigiria apagar e recriar tudo de uma vez |
| **Deployment** | Gerenciar **versões**: cria um ReplicaSet novo por template e transfere as réplicas aos poucos (2.3) | — (é o que se usa para aplicações sem estado) |

O nome do pod conta a hierarquia: `taskflow-api-7c6999f7c-b749p` = Deployment + hash do template (o ReplicaSet) +
sufixo do pod. Trocar a imagem gera um hash novo, ou seja, um ReplicaSet novo.

**Labels e selectors:** o Deployment reconhece os pods que são dele **pelos labels**, não pelo nome. O
`selector.matchLabels` precisa bater com os labels do `template`, senão a API recusa o manifesto.

### Container reinicia × pod é substituído

| | O container reinicia | O pod é substituído |
|---|---|---|
| Quando | O processo saiu (o kubelet aplica a `restartPolicy`) | O pod foi apagado, ou o nó caiu |
| Nome e IP | Os mesmos | **Novos** (`10.244.2.2` → `10.244.2.3` no experimento) |
| `RESTARTS` | Sobe | Recomeça do 0 |

**O IP de um pod não é estável.** Ninguém chama um pod pelo IP: é para isso que existe o *Service* (2.2).

### `CrashLoopBackOff`

Não é um erro, é um **estado de espera**: o container sai, o kubelet reinicia, sai de novo, e o kubelet passa a
esperar cada vez mais entre as tentativas (10 s, 20 s, 40 s… até 5 min). O *backoff* existe para não martelar um
processo que está quebrado (nem o banco, nem a API externa que ele chama no boot).

### O scheduler e os nós

- **Taint e toleration:** o control-plane tem o *taint* `node-role.kubernetes.io/control-plane:NoSchedule`, uma
  "repelência": só pods que declaram **tolerá-lo** vão para lá. É por isso que os pods do TaskFlow caem nos workers.
- **Ele decide uma vez, na criação, e não rebalanceia.** Os dois `coredns` ficaram no control-plane: toleram o taint
  e nasceram (aos 2m12s) antes de os workers entrarem (aos 2m09s de idade). Continuam lá até serem recriados.
- **Pontuação, não rodízio:** com 3 réplicas, o 3º pod foi para o worker que já tinha um. Ao reduzir para 2, o
  ReplicaSet tirou justamente um dos dois desse worker: ele prefere manter as réplicas espalhadas.

### Duas redes

| Faixa | O que é |
|---|---|
| `172.19.0.x` | IPs dos **nós** (a rede Docker `kind`). `etcd`, `apiserver`, `kube-proxy` e `kindnet` usam a rede do próprio nó (`hostNetwork`) |
| `10.244.x.x` | A **rede dos pods**: cada pod comum ganha um IP dela |

### `apply`, drift e a fonte da verdade

- `kubectl apply -f` envia o estado desejado e é **idempotente**: cria o que não existe, atualiza só o que mudou.
- Ele guarda o último manifesto aplicado no próprio objeto (`kubectl.kubernetes.io/last-applied-configuration`) para
  calcular a diferença entre **o último aplicado, o que está no cluster e o arquivo**.
- `kubectl scale` (imperativo) muda o cluster por fora: o `kubectl diff` mostrou `replicas: 3` no cluster contra `2`
  no arquivo. Isso é **drift**, e o próximo `apply` desfaz a mudança de quem escalou "na mão". **O arquivo no Git é a
  fonte da verdade**: a ideia que leva ao GitOps (2.6).
- O objeto no cluster tem mais campos que o arquivo: a API **preenche os padrões** (`progressDeadlineSeconds: 600`,
  `revisionHistoryLimit: 10`), e cada mudança no `spec` incrementa a `generation`.

### Por que kind

| Opção | Por que sim ou não |
|---|---|
| **kind** (*Kubernetes IN Docker*) | ✅ A escolha. Cada nó é um container rodando o Kubernetes **oficial**; é o que o próprio projeto usa para se testar; cluster de **vários nós**; configuração num arquivo versionado; sobe em ~1 min |
| minikube | Um nó por padrão, e addons que escondem o que o Kubernetes faz |
| k3d (k3s) | Leve e ótimo, mas é uma distribuição própria, com diferenças |

O `kind` só cria e apaga o cluster. Todo o resto passa pelo `kubectl`, como seria no EKS ou no GKE: o que se aprende
aqui vale lá.

### Estado no Kubernetes: StatefulSet e volumes (2.2)

| | Deployment | **StatefulSet** |
|---|---|---|
| Nome dos pods | Aleatório (`taskflow-api-6b456c7c95-2qfbh`) | **Estável** (`postgres-0`, sempre) |
| Disco | Nenhum por réplica (os pods são intercambiáveis) | **Um PVC por réplica**, que sobrevive ao pod |
| Ordem | Todos de uma vez | Uma réplica por vez, em ordem |
| Para | Processos sem estado (a API) | Bancos, brokers (o Kafka, na 2.4) |

**O disco tem três peças:**

| Peça | O que é | No experimento |
|---|---|---|
| **StorageClass** | O "fornecedor" de discos e as regras dele | `standard` (o `local-path` do kind): uma pasta no nó |
| **PersistentVolumeClaim** (PVC) | O **pedido**: "1 GiB, leitura e escrita por um nó" (`RWO`) | `data-postgres-0`, criado pelo `volumeClaimTemplates` |
| **PersistentVolume** (PV) | O **disco de fato**, que atende o pedido | Criado pelo StorageClass; `Bound` ao PVC |

- **`WaitForFirstConsumer`:** o disco só é criado quando o pod é agendado (o PV nasceu 2 s depois do PVC), e por isso
  nasce **no nó do pod**. Um disco local não pode ser montado de outra máquina.
- **A prova:** o pod `postgres-0` apagado voltou com o mesmo nome, montou o mesmo PVC (10 min de idade contra 8 s do
  pod), subiu em 8 s sem *initdb* (a primeira subida levou 16 s), e o cadastro continuava lá.
- **`RECLAIM POLICY: Delete`:** apagar o **pod** é seguro, apagar o **StatefulSet** também (por padrão ele não apaga os
  PVCs), mas apagar o **PVC** apaga o disco. Em produção, volume de banco usa `Retain`, e **backup não é opcional**:
  volume persistente protege da queda de um pod, não de um comando errado.
- **Banco em produção costuma ficar fora do cluster** (RDS, Cloud SQL): backup, failover e upgrade gerenciados. Aqui
  está dentro para o cluster local ser completo e para exercitar estado no Kubernetes.

### Service: um endereço estável (2.2)

O IP de um pod muda a cada recriação (visto na 2.1). Um **Service** dá um nome e um endereço estáveis, e o DNS
interno (CoreDNS) resolve o nome dentro do cluster:

| Tipo | Como funciona | No TaskFlow |
|---|---|---|
| **ClusterIP** | Um IP virtual que o `kube-proxy` de cada nó distribui entre os pods do `selector` | `taskflow-api` (porta 80 → `http` do container) |
| **Headless** (`clusterIP: None`) | Sem IP virtual: o DNS devolve direto o IP do pod (e `postgres-0.postgres` aponta para aquele pod) | `postgres`, o Service que o StatefulSet exige |

**Quem está por trás do Service:** um controller mantém o **EndpointSlice**, a lista de IPs dos pods que têm o label
do `selector` **e estão prontos**. Um pod que deixa de estar pronto sai da lista e para de receber tráfego: é isso que
a readiness probe controla (2.3). `targetPort: http` usa o **nome** da porta do container: mudar o número lá não
exige mudar aqui.

### ConfigMap × Secret (2.2)

| | ConfigMap | Secret |
|---|---|---|
| Para quê | Configuração comum (`NODE_ENV`, `LOG_LEVEL`) | Senha do banco, `JWT_SECRET` |
| Vai para o Git? | ✅ Como qualquer manifesto | ❌ **Nunca.** Criado por `kubectl create secret`, com valores aleatórios gerados na hora |
| Como chega ao container | `envFrom` (todas as chaves viram variáveis) | `valueFrom.secretKeyRef` (uma chave por variável) |

**Um Secret não é cifrado, é base64.** O `kubectl get secret … -o jsonpath='{.data.password}' | base64 -d` mostrou a
senha em claro, sem chave nenhuma. Quem pode **ler** Secrets no namespace lê a senha, e um YAML de Secret no Git é uma
senha no Git. Em produção: RBAC restringindo a leitura de Secrets, o etcd configurado para cifrá-los no disco, e o
valor vindo de um cofre (**External Secrets Operator** + AWS Secrets Manager/Vault) ou cifrado no Git (**Sealed
Secrets**, **SOPS**). O Git guarda **qual** segredo a API espera (nome e chaves); o valor fica fora. É a exceção
consciente à regra do "Git é a fonte da verdade".

**A senha existe num lugar só:** o Kubernetes expande `$(POSTGRES_PASSWORD)` dentro do `value` de outra variável,
desde que ela venha **antes** na lista. A `DATABASE_URL` é montada no manifesto, e a senha é gerada em hex (sem `@`,
`/` ou `:`, que quebrariam a URL).

### A migração como Job (2.2)

Um **Job** roda um processo **até terminar com sucesso**; um Deployment o mantém vivo para sempre. A migração roda
**uma vez**, antes da API, e não no boot de cada réplica (corrida entre réplicas e permissão de DDL na API): o desenho
do target `migrate` da imagem ([Módulo 03](03-ci-cd-github-actions.md), E.1) virando realidade.

| Decisão | Por quê |
|---|---|
| **Nome com o commit** (`taskflow-migrate-aa4d4a0`) | O template de um Job é **imutável**: não se "atualiza" um Job que já rodou. Cada versão é um Job novo, e o histórico diz qual migração rodou com qual versão |
| `backoffLimit: 3` | Cobre o banco ainda subindo. Uma migração com erro falha as 4 vezes, o Job fica `Failed`, e o `kubectl wait` do deploy estoura: a API nova não sobe sobre um schema pela metade |
| `restartPolicy: Never` | Cada tentativa é um pod novo, e o log das que falharam continua lá |
| Sem `ttlSecondsAfterFinished` | O pod `Completed` (`0/1`: não há nada rodando para estar pronto) fica para o log ser lido |
| A ordem, à mão (`kubectl wait --for=condition=complete`) | Ver na mão o que precisa acontecer em sequência. Automatizar a ordem é a 2.6 |

### Troca de versão: o primeiro rolling update (2.2)

Mudar o template do pod (a API ganhou `envFrom` e `env`) criou um **ReplicaSet novo** (`6b456c7c95`) e esvaziou o
antigo (`7c6999f7c`, que ficou com `0`, guardado: é para ele que um rollback volta). `kubectl rollout status` acompanha
a troca até o fim, e é o comando que um pipeline usa para saber se o deploy deu certo. Sem probes (2.3), "pronto"
ainda é "processo rodando".

### Por que um rollout derruba requisições (2.3)

A linha de base da 2.3, medida com um k6 **dentro do cluster** durante um `kubectl rollout restart`, deu 32 falhas
em 16.655 requisições e ~4 s com o Service sem nenhum pod respondendo. Mesmo assim, o rollout terminou em
`successfully rolled out`. Os eventos explicam a sequência:

1. O pod novo é marcado **Ready no segundo em que o container inicia**, porque sem *readiness probe* "pronto" significa
   "processo rodando". O Nest ainda estava no boot, sem ouvir a porta 3000.
2. O Deployment usa esse "pronto" para decidir quando pode derrubar um pod velho. Com os novos "prontos" na hora,
   ele apagou os dois velhos em ~1,5 s. O padrão `maxUnavailable: 25%` (0 com 2 réplicas) não protegeu nada, porque
   ele conta pods *prontos*, e o "pronto" era falso.
3. O pod velho também fechou a porta na hora (`SHUTDOWN_DRAIN_MS` no padrão 0), enquanto o kube-proxy ainda mandava
   conexões para ele.

Resultado: `connection refused` no pod novo, que ainda não ouvia a porta; `request timeout` nas conexões presas ao
velho. **O Kubernetes só sabe o que o manifesto conta para ele.** São dois lados do problema, e cada um tem a sua
peça:

| Lado | O que dá errado | A peça que resolve |
|---|---|---|
| Pod **novo** | Recebe tráfego antes de responder | **readinessProbe**: só entra no Service quando `/health/ready` responde 200 |
| Pod **velho** | Fecha enquanto ainda recebe tráfego | **Drenagem**: continua atendendo por 5 s depois do SIGTERM, com readiness 503 e `Connection: close` ([Módulo 01](01-observabilidade.md)) |
| O Deployment | Derruba capacidade antes de ter substituto | `maxSurge: 1` + `maxUnavailable: 0`: sobe 1 novo, espera ele ficar pronto, e só então derruba 1 velho |

**Por que a drenagem é necessária, se a readiness existe:** quando um pod é apagado, o kubelet manda o SIGTERM e o
controller de EndpointSlice tira o pod do Service **ao mesmo tempo**, e cada kube-proxy aplica a remoção nas regras do
seu nó um instante depois. A readiness não ajuda aqui: o pod já está saindo. A medição isolou cada peça: com
readiness e **sem** drenagem, foram 11 falhas, em duas rajadas, uma por pod velho; com as duas, 0. A janela existe
até no kind (3 nós na mesma máquina). Num cluster grande, ou com um balanceador de nuvem na frente, ela é maior.

**Drenagem na app × `preStop`:** quem não tem drenagem no código usa `lifecycle.preStop: sleep: { seconds: 5 }` (nativo
desde o 1.30), e o kubelet espera antes de mandar o SIGTERM. Aqui ela já existia na aplicação (Módulo 01), com o bônus
do readiness 503 e do `Connection: close` para quem mantém conexão aberta. Usar as duas somaria as esperas.

### Três probes, três perguntas (2.3)

| Probe | Pergunta | Se falhar | Rota e ritmo |
|---|---|---|---|
| **startup** | "Já terminou de subir?" | Enquanto não passa, as outras não rodam; esgotou, reinicia | `/health/live`, a cada 2 s, até 30 vezes (60 s) |
| **liveness** | "O processo travou?" | O kubelet **reinicia** o container | `/health/live`, a cada 10 s, 3 falhas |
| **readiness** | "Posso receber tráfego?" | Sai do Service (EndpointSlice), **sem** reiniciar | `/health/ready`, a cada 5 s, 2 falhas |

- **Liveness nunca consulta dependência.** Com a liveness no `/health/ready`, um Postgres fora do ar faria o
  kubelet reiniciar **todas** as réplicas juntas (*restart storm*): reiniciar a API não conserta o banco, e o boot
  simultâneo ainda pesaria nele na volta. O `k8s-api-manifest.spec.ts` trava essa regra.
- **A startup existe para a liveness poder ser rápida.** Sem ela, a liveness teria que tolerar o pior boot (disco
  frio, imagem grande) e demoraria para detectar um travamento real.
- **A readiness consulta o banco, e isso é uma escolha com custo:** banco fora significa todas as réplicas fora do
  Service, e o cliente recebe `connection refused` em vez de um 503 com mensagem. Para uma API que sem banco não
  responde nada útil, é aceitável. Uma API com cache ou rotas sem banco deixaria o banco fora da readiness.

### Recursos: medir antes de declarar (2.3)

> A decisão, com as alternativas recusadas e quando revisitá-la: [ADR-0013](../adr/0013-recursos-medidos-sem-limit-de-cpu.md).

O **request** é o que o scheduler **reserva** no nó: decide onde o pod cabe e garante a parte dele quando há disputa.
O **limit** é o teto. Os números vieram do cgroup do container (`memory.current`, `memory.peak`, `cpu.stat`), lido
com `kubectl exec` antes e depois de 90 s de carga:

| Medida (por pod) | Valor | Decisão |
|---|---|---|
| Memória, pico do boot | 183 MiB | `requests.memory: 192Mi` (reservar menos deixaria o nó superlotar no boot) |
| Memória, sob carga | ~110 MiB | `limits.memory: 384Mi` (2× o pico: rotas com bcrypt e banco custam mais que o `/health/live` medido) |
| CPU, ~97 req/s | ~0,04 núcleo | `requests.cpu: 100m`, **sem** `limits.cpu` |

- **Memória tem limit, CPU não.** Memória não é comprimível: sem limit, um vazamento esgota o nó e o kernel mata
  processos dos vizinhos. Com limit, quem morre é o próprio pod (`OOMKilled` no `describe`), e o kubelet o
  reinicia. CPU é comprimível: falta de CPU vira lentidão, não morte. O limit de CPU aplica *throttling* por janela de
  100 ms mesmo com o nó ocioso, o que aparece como latência de cauda (p99) sem causa visível. O request já garante a
  parte justa de cada pod.
- **O Node lê o limit.** O Node 20+ dimensiona o heap pelo limit de memória do cgroup, não pela memória do nó.
- **No kind, os requests não protegem nada.** Cada nó diz ter 16 CPUs e 32 GiB (`allocatable`), mas os três são
  containers na **mesma** máquina: o cluster acha que tem 3× o hardware real. Num cluster de verdade, são a base da
  decisão do scheduler e do HPA (2.5).
- **Postgres:** 26 MiB medidos com o banco vazio, mas ele cresce até o `shared_buffers` (128 MB) mais o `work_mem` de
  cada consulta. `request` 256Mi e `limit` 512Mi, com folga larga, porque um OOMKill no banco derruba todas as conexões
  de uma vez.

### `securityContext` e Pod Security Admission (2.3)

| Campo | O que impede |
|---|---|
| `runAsNonRoot: true` + `runAsUser: 1000` | O kubelet recusa iniciar o container como root. O `USER 1000:1000` numérico da imagem (Módulo 03, E.1) foi feito para isto: com `USER node`, o kubelet não teria como conferir |
| `readOnlyRootFilesystem: true` | Quem invadir não grava binário nem altera o código. A API e o Prisma CLI (o Job de migração) rodaram sem gravar em disco; se precisassem, um `emptyDir` só no diretório necessário |
| `allowPrivilegeEscalation: false` | Um processo filho não ganha mais privilégio que o pai (setuid, sudo) |
| `capabilities: drop: ['ALL']` | Nenhuma capability do Linux; a porta 3000 não é privilegiada |
| `seccompProfile: RuntimeDefault` | Bloqueia syscalls que um servidor Node nunca usa |
| `automountServiceAccountToken: false` | A API não fala com a API do Kubernetes; uma invasão não ganha uma credencial do cluster |

O **Pod Security Admission** é o API server avaliando cada pod contra os perfis padrão **antes** de ele existir, por
labels no namespace. Aqui: `enforce: baseline` (recusa o que é claramente perigoso: `privileged`, `hostNetwork`,
`hostPath`) e `warn`/`audit: restricted` (o perfil mais rígido, só avisando). No `apply`, o aviso veio **só** para o
Postgres, listando as 4 regras que ele não cumpre; a API, o Job e o k6 passaram calados. Subir para `enforce:
restricted` é uma linha, depois de endurecer o Postgres.

### Rollback: o deploy quebrado não derruba nada (2.3)

Um `JWT_SECRET` curto demais (`kubectl set env`) simulou uma versão ruim. O schema recusa o boot e o pod novo entra em
`CrashLoopBackOff`, com a espera entre tentativas dobrando (10 s, 20 s, 40 s, 80 s). Com `maxUnavailable: 0`, os dois
pods velhos **nunca saíram**, e o k6 registrou 0 falhas em 17.650 requisições. Aos 120 s (`progressDeadlineSeconds`),
o `rollout status` saiu com `exceeded its progress deadline`: é o erro que faz um pipeline de CD falhar e avisar
alguém. O deploy ruim custa tempo, não disponibilidade.

`kubectl rollout undo` volta à revision anterior **reativando o ReplicaSet antigo**, sem reconstruir nada: os pods
velhos continuaram os mesmos, com a mesma idade, e só o pod quebrado foi removido. Mas o `undo` é imperativo: o
próprio kubectl avisa que a anotação `last-applied-configuration` não acompanha. Num fluxo GitOps (2.6), o rollback é
um `git revert`, e o cluster segue o Git.


---

## 📋 Como reproduzir

### 1. Ferramentas: versão fixa e checksum conferido

Binário oficial, numa versão fixa, conferido contra o SHA-256 publicado antes de instalar (a mesma lógica de cadeia
de suprimentos do Módulo 03, E.2). Sem `curl | bash` e sem o pacote do sistema (desatualizado).

```bash
cd /tmp
curl -LO "https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl"
curl -LO "https://dl.k8s.io/release/v1.37.2/bin/linux/amd64/kubectl.sha256"
echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check          # kubectl: OK
sudo install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl
kubectl version --client                                            # v1.37.2 (com Kustomize v5.8.1 embutido)

curl -LO "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64"
curl -LO "https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64.sha256sum"
sha256sum --check kind-linux-amd64.sha256sum                        # kind-linux-amd64: OK
sudo install -o root -g root -m 0755 kind-linux-amd64 /usr/local/bin/kind
kind version                                                        # v0.33.0
rm kubectl kubectl.sha256 kind-linux-amd64 kind-linux-amd64.sha256sum; cd -
```

O `kubectl` pode estar uma versão *minor* acima ou abaixo do cluster: 1.37.2 com o nó 1.37.0.

### 2. O cluster

```bash
kind create cluster --config k8s/kind-config.yaml     # ~1 min; grava ~/.kube/config e o contexto kind-taskflow
kubectl cluster-info                                  # a API em https://127.0.0.1:<porta>
kubectl get nodes -o wide                             # 3 nós Ready, v1.37.0, containerd
docker ps --filter name=taskflow- --format 'table {{.Names}}\t{{.Image}}'   # os nós são containers kindest/node
kubectl get namespaces                                # default, kube-system, kube-public, kube-node-lease, local-path-storage
kubectl get pods -n kube-system -o wide               # o próprio Kubernetes, rodando como pods
kubectl describe node taskflow-control-plane | grep -A2 Taints
```

### 3. O Deployment, que falha de propósito

```bash
kubectl apply -f k8s/base/namespace.yaml
kubectl apply -f k8s/base/api.yaml --dry-run=server   # a API valida sem gravar
kubectl apply -f k8s/base/api.yaml
kubectl get pods -n taskflow -o wide --watch          # ContainerCreating → Running → Error → CrashLoopBackOff
```

### 4. O diagnóstico (do geral para o específico)

```bash
kubectl get deployment,replicaset,pods -n taskflow                                   # o objeto está como pedi? 0/2
kubectl describe pod -n taskflow -l app.kubernetes.io/name=taskflow-api | grep -A6 "Last State"   # Exit Code 1
kubectl get events -n taskflow --sort-by=.lastTimestamp                               # o que o Kubernetes fez
kubectl logs -n taskflow deploy/taskflow-api | head -25                               # o porquê
```

| Pergunta | Comando | Resposta |
|---|---|---|
| O objeto está como eu pedi? | `get` | Não: `0/2` prontos |
| Como o container terminou? | `describe` → `Last State` | Exit code **1**: o processo decidiu sair (137 seria SIGKILL, como falta de memória) |
| O que o Kubernetes fez? | `get events` | Tudo certo do lado dele (escalonou, baixou, iniciou): o problema está **dentro** do processo |
| Por quê? | `logs` | `DATABASE_URL` e `JWT_SECRET` ausentes: o fail-fast de configuração do Módulo 01 |

### 5. A reconciliação observada

```bash
kubectl delete pod -n taskflow -l app.kubernetes.io/name=taskflow-api --wait=false
kubectl get pods -n taskflow                          # 2 pods NOVOS em segundos, o mesmo ReplicaSet
kubectl scale deployment taskflow-api -n taskflow --replicas=3
kubectl diff -f k8s/base/api.yaml                     # drift: replicas 3 no cluster, 2 no arquivo
kubectl apply -f k8s/base/api.yaml                    # o arquivo vence: volta para 2
```

### 6. Configuração e segredos (2.2)

```bash
kubectl create secret generic taskflow-db -n taskflow --from-literal=password="$(openssl rand -hex 24)"
kubectl create secret generic taskflow-api -n taskflow --from-literal=jwt-secret="$(openssl rand -hex 32)"
kubectl get secret taskflow-db -n taskflow -o jsonpath='{.data.password}' | base64 -d; echo   # base64 não é cifra
kubectl apply -f k8s/base/config.yaml
```

### 7. O banco, a migração e a API, nesta ordem (2.2)

```bash
kubectl apply -f k8s/base/postgres.yaml
kubectl get pods -n taskflow -l app.kubernetes.io/name=postgres --watch     # postgres-0: Running 0/1 → 1/1 (initdb)
kubectl get pvc,pv -n taskflow                                              # Bound; o PV criado com o pod

kubectl apply -f k8s/base/migrate-job.yaml
kubectl wait --for=condition=complete job/taskflow-migrate-aa4d4a0 -n taskflow --timeout=120s
kubectl logs -n taskflow job/taskflow-migrate-aa4d4a0                       # 20 migrações aplicadas

kubectl apply -f k8s/base/api.yaml
kubectl rollout status deployment/taskflow-api -n taskflow --timeout=120s
kubectl get replicaset,pods,endpointslices -n taskflow
```

### 8. Testar de fora e provar o StatefulSet (2.2)

```bash
kubectl port-forward -n taskflow svc/taskflow-api 8080:80        # numa aba própria: o túnel prende o terminal
curl -s localhost:8080/health/ready; echo                         # database: up
curl -s -X POST localhost:8080/auth/register -H 'Content-Type: application/json' \
  -d '{"name":"Cassio K8s","email":"k8s@example.com","password":"Senha-forte-123"}'; echo
curl -s -o /dev/null -w '%{http_code}\n' localhost:8080/docs      # 404: NODE_ENV=production
kubectl exec -n taskflow postgres-0 -- psql -U taskflow -d taskflow -c 'SELECT email FROM "User";'

kubectl delete pod postgres-0 -n taskflow                         # o pod some...
kubectl get pods,pvc -n taskflow -l app.kubernetes.io/name=postgres
kubectl exec -n taskflow postgres-0 -- psql -U taskflow -d taskflow -c 'SELECT email FROM "User";'   # ...os dados, não
```

### 9. Medir um rollout sob carga (2.3)

A carga roda **dentro** do cluster: o `port-forward` se prende a um pod e cai com ele, então mediria o túnel, não a
aplicação. Use três terminais:

```bash
# Terminal 1: 90 s de carga em /health/live (sem throttler, sem banco: uma falha só pode ser de conexão)
kubectl -n taskflow delete job k6-rollout --ignore-not-found     # o template de um Job é imutável
kubectl apply -f k8s/load/k6-rollout.yaml
kubectl -n taskflow wait --for=condition=Ready pod -l app.kubernetes.io/name=k6-rollout --timeout=180s
kubectl -n taskflow logs -f job/k6-rollout                       # no fim: http_req_failed (meta: 0)

# Terminal 2: a troca, pod a pod
kubectl -n taskflow get pods -l app.kubernetes.io/name=taskflow-api -w

# Terminal 3, ~15 s depois de a carga começar: uma "versão nova" sem publicar nada (muda só uma anotação)
kubectl -n taskflow rollout restart deployment/taskflow-api
kubectl -n taskflow rollout status deployment/taskflow-api
```

O consumo, para dimensionar os `resources` (rode antes e depois de uma carga sem rollout, e compare):

```bash
for p in $(kubectl -n taskflow get pods -l app.kubernetes.io/name=taskflow-api -o name); do
  echo "== $p"
  kubectl -n taskflow exec $p -- cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.peak
  kubectl -n taskflow exec $p -- grep usage_usec /sys/fs/cgroup/cpu.stat   # contador: vale a diferença
done
```

### 10. Aplicar a 2.3, na ordem (2.3)

```bash
kubectl diff -f k8s/base/namespace.yaml -f k8s/base/config.yaml -f k8s/base/postgres.yaml -f k8s/base/api.yaml
kubectl apply -f k8s/base/namespace.yaml                          # a regra de segurança antes dos pods novos
kubectl apply -f k8s/base/config.yaml -f k8s/base/postgres.yaml   # Warning: o Postgres viola o "restricted"
kubectl -n taskflow rollout status statefulset/postgres
kubectl -n taskflow delete job taskflow-migrate-aa4d4a0           # Job imutável: recriar (as migrações são idempotentes)
kubectl apply -f k8s/base/migrate-job.yaml
kubectl -n taskflow wait --for=condition=complete job/taskflow-migrate-aa4d4a0 --timeout=120s
kubectl apply -f k8s/base/api.yaml
kubectl -n taskflow rollout status deployment/taskflow-api
kubectl -n taskflow exec deploy/taskflow-api -- id                # uid=1000
kubectl -n taskflow exec deploy/taskflow-api -- touch /app/x      # Read-only file system (o erro é o resultado certo)
```

Depois, repita o passo 9: a meta é `http_req_failed` 0.

### 11. Isolar a drenagem, e o rollback (2.3)

```bash
# Drenagem desligada só no cluster (drift proposital). O ConfigMap muda, mas os pods NÃO: env é lido no start
kubectl -n taskflow patch configmap taskflow-api --type merge -p '{"data":{"SHUTDOWN_DRAIN_MS":"0"}}'
kubectl -n taskflow exec deploy/taskflow-api -- printenv SHUTDOWN_DRAIN_MS        # ainda 5000
kubectl -n taskflow rollout restart deployment/taskflow-api                       # agora 0; repita o passo 9
kubectl apply -f k8s/base/config.yaml && kubectl -n taskflow rollout restart deployment/taskflow-api   # volta ao Git

# Uma versão quebrada, com a carga do passo 9 rodando
kubectl -n taskflow set env deployment/taskflow-api JWT_SECRET=curto              # o schema recusa o boot
kubectl -n taskflow rollout status deployment/taskflow-api                        # 120 s → exceeded its progress deadline
kubectl -n taskflow rollout history deployment/taskflow-api
kubectl -n taskflow rollout undo deployment/taskflow-api
```

Para apagar tudo: `kind delete cluster --name taskflow`. Num cluster novo, os Secrets precisam ser criados de novo
(não estão no Git).

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | Por ~2 s, o pod que ia morrer apareceu como `READY 1/1` | Sem *readiness probe*, "processo rodando" é tratado como "pronto". Com um Service na frente, chegaria tráfego a um pod que nem subiu | Esperado na 2.1 (o manifesto mínimo). **(2.3)** Medido e resolvido: ver problema 8 |
| 2 | `kubectl describe pod -l …` não trouxe a seção `Events` | No `kubectl` 1.37, o `describe` com seletor de label veio sem os eventos | `kubectl get events -n <ns> --sort-by=.lastTimestamp`: o histórico do namespace inteiro, em ordem. Eventos **expiram** (1 h por padrão): num incidente, colete cedo |
| 3 | `kubectl logs --previous` respondeu `unable to retrieve container logs` | Com o pod parado em `Error`/`CrashLoopBackOff`, o container "atual" **já é** a tentativa que morreu, e o anterior a ela o kubelet já descartou | Pod parado: `kubectl logs` **sem** `--previous`. O `--previous` é para o pod que reiniciou e está `Running` |
| 4 | A mensagem de erro de boot manda conferir o `.env` | Escrita para o desenvolvimento local; num container não existe `.env` | **(2.2)** O texto passou a citar os dois lugares: o `.env` no desenvolvimento, o ConfigMap e o Secret num container |
| 5 | O erro de boot saiu em **texto**, não em JSON | O logger JSON (pino) só assume depois de o Nest subir; um erro antes disso sai no formato padrão do Nest | Registrado (limitações): a linha mais importante de um `CrashLoopBackOff` chega a um agregador sem estrutura |
| 6 | **(2.2)** O `curl` digitado na aba do `port-forward` não executou | O `port-forward` prende o terminal enquanto o túnel está aberto; o texto fica na fila e só roda quando o túnel fecha | O túnel numa aba própria, os testes em outra |
| 7 | **(2.2)** O CodeQL reprovou o PR: *Incomplete string escaping* (High) no `test-images.spec.ts` | A primeira versão do teste montava uma regex com o nome da imagem e escapava **só o ponto**; uma regex tem outros metacaracteres, e o escape parcial é um padrão frágil (a entrada era o nosso compose, mas o CodeQL não tem como saber) | Sem regex montada com texto: tag comparada por **igualdade** e digest por uma regex fixa. As duas mutações (tag e digest errados) continuam reprovando. O portão de *code scanning* da E.2 pegando código nosso |
| 8 | **(2.3)** Um `rollout restart` derrubou 32 de 16.655 requisições, com ~4 s sem nenhum pod respondendo, e o rollout disse `successfully rolled out` | Sem readiness, o pod novo virou Ready no segundo em que o container iniciou, e o Deployment apagou os dois velhos em ~1,5 s; os velhos também fecharam a porta na hora (drenagem 0) | Readiness, startup e liveness; `maxSurge 1`/`maxUnavailable 0`; drenagem de 5 s. Medido de novo: **0** de 17.610 |
| 9 | **(2.3)** Com readiness e sem drenagem, ainda 11 falhas | O SIGTERM e a saída do Service acontecem em paralelo; o kube-proxy aplica a remoção um instante depois | `SHUTDOWN_DRAIN_MS=5000` no ConfigMap. A peça isolada com um experimento: drenagem 0 → 11 falhas, 5000 → 0 |
| 10 | **(2.3)** Mudar o ConfigMap não mudou os pods (`printenv` ainda mostrava o valor antigo) | O `envFrom` é lido **uma vez**, quando o container inicia | `kubectl rollout restart` depois de mudar o ConfigMap. Automatizar (hash do conteúdo no nome do ConfigMap, com o `configMapGenerator` do Kustomize) é a 2.6 |
| 11 | **(2.3)** O `rollout undo` avisou que a `last-applied-configuration` não acompanha | O `undo` muda o objeto direto, sem passar pelo `apply`; o próximo `apply` calcula o diff a partir de uma anotação que não reflete o cluster | Rollback imperativo é para emergência. O estado se resolve no Git; em GitOps (2.6), o rollback é um `git revert` |
| 12 | **(2.3)** `rollout history` com `CHANGE-CAUSE` vazio em todas as revisions | O campo vem da anotação `kubernetes.io/change-cause`, que ninguém preencheu | Aceito: o "porquê" de cada versão fica no Git (commit e digest). O pipeline da 2.6 pode preencher a anotação |

---

## 📊 Resultados obtidos

**2.1 — cluster local e o primeiro Deployment**

| Experimento | Resultado |
|---|---|
| Instalação | `kubectl` 1.37.2 e `kind` 0.33.0, os dois com o SHA-256 conferido (`OK`) |
| `kind create cluster` | 3 nós `Ready` (1.37.0, Debian 13, containerd 2.3.4); a API em `127.0.0.1:<porta>` |
| Pods do sistema | apiserver, etcd, scheduler e controller-manager no control-plane; `kube-proxy` e `kindnet` um por nó; os 2 `coredns` no control-plane (toleram o taint e nasceram antes dos workers) |
| Deployment com 2 réplicas | Um pod em cada worker; nenhum no control-plane |
| Imagem do GHCR por digest | Baixada pelo kubelet em 10,8 s (131 MB, pacote público, sem credencial); nas reinicializações, "already present on machine" |
| O ciclo de falha | `ContainerCreating` → `Running` (`READY 1/1` por ~2 s) → `Error` → `CrashLoopBackOff`, com a espera entre tentativas crescendo |
| Diagnóstico | Exit code 1; eventos sem erro do lado do Kubernetes; log: `DATABASE_URL` e `JWT_SECRET` ausentes |
| `delete` dos 2 pods | 2 pods novos em ~5 s, mesmo ReplicaSet, IPs novos, `RESTARTS` do 0 |
| `scale --replicas=3` + `diff` + `apply` | O 3º pod no worker que já tinha um; o `diff` mostrou o drift (3 × 2); o `apply` voltou para 2, tirando um pod do worker com dois |


**2.2 — banco, configuração e migração**

| Experimento | Resultado |
|---|---|
| Secrets por comando, valores aleatórios | `taskflow-db` e `taskflow-api` (`Opaque`); `base64 -d` mostrou a senha em claro |
| Postgres (StatefulSet) | `postgres-0` no `taskflow-worker2`: `Running` aos 11 s e `1/1` aos 16 s (o *initdb*); PVC `data-postgres-0` `Bound` a um PV de 1 GiB criado 2 s depois, com o pod |
| Job de migração | As 20 migrações aplicadas em 20 s (com o download da imagem `taskflow-migrate`); `Complete 1/1`; o pod ficou `Completed` |
| API | `kubectl apply` criou o ReplicaSet `6b456c7c95` (2/2 prontos, 0 reinícios); o `7c6999f7c` ficou com 0; EndpointSlice com os 2 IPs; logs em JSON com o nome do pod no `hostname` |
| De fora (`port-forward`) | `/health/ready` com `database: up`; cadastro 201, conferido com `psql` no pod do banco; `/docs` 404 (`NODE_ENV=production`) |
| `postgres-0` apagado | Voltou com o mesmo nome em 8 s, sem *initdb*, no mesmo PVC (10 min × 8 s); o cadastro continuava lá; a API reconectou sozinha (`database: up`), sem reiniciar |
| `test-images.spec.ts` | Confere também o Postgres do manifesto (tag do compose + digest). **Mutação:** `postgres:18.6` no manifesto → o teste falha dizendo a versão esperada |


**2.3 — troca de versão sem perder requisição**

| Experimento | Resultado |
|---|---|
| Linha de base: `rollout restart` sob ~185 req/s, sem probes nem drenagem | **32 falhas** em 16.655 (22 `connection refused` em ~1 s, depois 10 `request timeout`); ~4 s sem nenhuma requisição concluída; os 2 pods velhos apagados em ~1,5 s; `successfully rolled out` |
| Grupo de controle: carga sem rollout | 0 falhas em 17.590: as falhas vinham do rollout, não da carga |
| Consumo (cgroup) | Pico de 183 MiB no boot; ~110 MiB sob carga; ~0,04 núcleo por pod (diferença de `usage_usec` em ~95 s); Postgres 26 MiB (pico 34 MiB) |
| `apply` da 2.3 | `Warning` do Pod Security só no Postgres (4 regras do `restricted`); Job de migração com disco somente leitura: `No pending migrations to apply`; API `uid=1000`, `touch` recusado (`Read-only file system`) |
| 2.3 completa: `rollout restart` sob carga | **0 falhas** em 17.610; pod novo `0/1` por ~2 s antes de `1/1`; só então um velho em `Terminating`; o velho termina `Completed` (exit 0) 5 s depois: a drenagem |
| Só a drenagem desligada (`SHUTDOWN_DRAIN_MS=0`) | **11 falhas** em 17.339, em duas rajadas (uma por pod velho, ~3 s de intervalo); `Terminating` → `Completed` em ~1 s |
| Versão quebrada (`JWT_SECRET` curto) sob carga | Pod novo em `CrashLoopBackOff` (esperas 10/20/40/80 s); os 2 velhos `1/1` o tempo todo; **0 falhas** em 17.650; `exceeded its progress deadline` aos 120 s |
| `rollout undo` | O ReplicaSet anterior reativado: os mesmos 2 pods (4 min de idade, 0 reinícios), o quebrado removido |
| `k8s-api-manifest.spec.ts` | 5 testes. **Mutações:** grace 15 s (abaixo do watchdog de 20 s), liveness em `/health/ready` e `LOG_PRETTY=true` no ConfigMap, todas reprovando |

---

## 🔄 Como este módulo evoluiu com o projeto

| Antes | Hoje | Por quê |
|---|---|---|
| A imagem publicada no GHCR, sem ninguém para rodá-la | **(2.1)** Um cluster local reproduzível (arquivo versionado, versão fixada) rodando a imagem por digest | O fim do pipeline precisa de um orquestrador: réplicas, troca de versão, tráfego só para o que está pronto |
| A API em `CrashLoopBackOff`, sem configuração nem banco | **(2.2)** Postgres num StatefulSet com volume, ConfigMap no Git e Secrets fora dele, migração como Job, e a API atrás de um Service | O deploy completo de um serviço com estado: a ordem banco → migração → API, e cada tipo de objeto no seu papel |
| A versão do Postgres em três lugares (compose, testes, smoke) | **(2.2)** Quatro, com o manifesto, e o `test-images.spec.ts` vigiando os quatro | O Dependabot não lê manifestos do Kubernetes: sem o teste, o cluster ficaria numa versão e o resto em outra |
| Pod "pronto" = container iniciado; rollout derrubando 32 de 16.655 requisições | **(2.3)** Três probes, `maxUnavailable: 0`, drenagem de 5 s: 0 falhas, medido; versão quebrada sem derrubar nada | O `/health/ready` e o graceful shutdown do Módulo 01 ganharam quem os consuma, e cada peça foi provada isolada |
| Sem `resources` nem `securityContext` | **(2.3)** Recursos a partir do cgroup medido; não-root, disco somente leitura, sem capabilities; Pod Security no namespace | O scheduler só decide bem com requests reais; o perfil `restricted` é verificado pelo API server, não pela boa vontade |
| Módulo planejado "para um ambiente Linux dedicado" | Feito no Linux de desenvolvimento, com kind | O kind roda o Kubernetes oficial em containers: não precisa de máquina dedicada |

---

## 🚧 Limitações e próximos passos

- **Secrets criados à mão:** num cluster novo, alguém precisa rodar o `kubectl create secret` (e guardar os valores
  fora). O caminho de produção é o External Secrets Operator lendo de um cofre, ou Sealed Secrets/SOPS no Git.
- **Postgres sem backup, sem réplica e como root:** um pod, um disco local, `RECLAIM POLICY: Delete`, e a imagem
  oficial rodando com o usuário padrão. Em produção, um banco gerenciado (ou um operador como o CloudNativePG).
  Por isso o namespace fica em `enforce: baseline`, com o `restricted` só avisando: endurecer o Postgres (uid 999,
  `fsGroup` no volume) libera o `enforce: restricted`.
- **Mudar o ConfigMap exige `rollout restart`:** os pods leem o ambiente só no start (2.6: hash no nome).
- **Recursos medidos com o caminho mais barato:** o `/health/live` não toca o banco nem o bcrypt. O dimensionamento
  real vem das métricas de produção (ou de um VPA em modo recomendação), não de um teste local.
- **Readiness depende do banco:** com o Postgres fora, todas as réplicas saem do Service ao mesmo tempo, e o cliente
  recebe `connection refused` em vez de um 503 com mensagem (decisão consciente; ver "Três probes").
- **Sem PodDisruptionBudget nem espalhamento garantido:** o scheduler distribuiu as réplicas pelos dois workers, mas
  nada o obriga (`topologySpreadConstraints`), e um `kubectl drain` de nó pode tirar as duas de uma vez (2.5).
- **A ordem banco → migração → API é manual** (`kubectl wait`); automatizá-la é a 2.6.
- **Telemetria desligada no cluster** (`OTEL_SDK_DISABLED`): ainda não há coletor lá dentro.
- **Acesso só por `port-forward`:** um túnel de depuração, que fixa um pod e não balanceia; o acesso de verdade é o
  Ingress (2.5).
- **Erro de boot fora do JSON:** o que acontece antes de o pino assumir sai em texto.
- **O digest no manifesto é atualizado à mão:** a cada imagem nova, alguém precisa trocar o `sha256`. Automatizar
  (a segunda metade do CD) é a 2.6.
- **Cluster local, de um computador:** sem alta disponibilidade do control-plane (um nó só) nem nós em zonas
  diferentes. Os conceitos são os mesmos de um cluster gerenciado (EKS, GKE); a operação do control-plane, não.

---

## ✅ Checklist

- [x] `kubectl` e `kind` instalados em versão fixa, com checksum conferido (2.1)
- [x] Cluster de 3 nós a partir de um arquivo versionado, com a versão do Kubernetes fixada por digest (2.1)
- [x] Namespace próprio e o primeiro Deployment, com a imagem por digest (2.1)
- [x] Um `CrashLoopBackOff` diagnosticado com `get`, `describe`, `events` e `logs` (2.1)
- [x] Reconciliação observada: pods recriados, escala, drift e o `apply` como fonte da verdade (2.1)
- [x] Postgres num StatefulSet com volume persistente, provado apagando o pod (2.2)
- [x] ConfigMap no Git e Secrets fora dele; a `DATABASE_URL` montada a partir do Secret (2.2)
- [x] Migração como Job, com nome por commit e a ordem garantida por `kubectl wait` (2.2)
- [x] A API respondendo por um Service, com o primeiro rolling update (2.2)
- [x] Linha de base medida com carga dentro do cluster: 32 falhas num rollout sem probes (2.3)
- [x] Startup, liveness e readiness, cada uma na rota certa, travadas por teste (2.3)
- [x] Rolling update sem erro (0 falhas, medido) e a drenagem provada isolada (11 → 0) (2.3)
- [x] Recursos a partir do consumo medido no cgroup; sem limit de CPU, por decisão (2.3)
- [x] Não-root, disco somente leitura, sem capabilities, seccomp; Pod Security no namespace (2.3)
- [x] Versão quebrada sem derrubar nada, `progressDeadlineSeconds` e `rollout undo` (2.3)
- [ ] Workers no cluster (2.4)
- [ ] Ingress, HPA e NetworkPolicy (2.5)
- [ ] Ambientes com Kustomize e GitOps (2.6)

### Perguntas de entrevista (2.1)

- **"O que é um Pod, e por que não se cria Pod direto?"** A menor unidade (containers que compartilham rede e
  ciclo de vida). Sozinho, ninguém o recria: usa-se um controller (Deployment) que mantém as réplicas.
- **"Deployment × ReplicaSet?"** O ReplicaSet mantém N cópias de um template; o Deployment gerencia versões,
  criando um ReplicaSet por template e transferindo as réplicas.
- **"O pod está em `CrashLoopBackOff`. O que você faz?"** `get` (o estado), `describe` (exit code e eventos),
  `get events` (o que o Kubernetes fez), `logs` (o porquê; `--previous` se ele já reiniciou e está rodando). Exit 1
  é o processo; 137 é SIGKILL (memória, probe).
- **"Por que o Kubernetes é declarativo?"** Grava-se o estado desejado; controllers reconciliam continuamente.
  Resiste a falhas (o que some é recriado) e deixa o Git como fonte da verdade.

### Perguntas de entrevista (2.2)

- **"StatefulSet × Deployment?"** Identidade estável, um volume por réplica que sobrevive ao pod, ordem. Para banco e
  broker; Deployment para o que não tem estado.
- **"Secret do Kubernetes é seguro?"** É base64, não cifra. Segurança vem de RBAC, cifra do etcd no disco e de o valor
  vir de um cofre (External Secrets) ou ir cifrado (Sealed Secrets/SOPS); nunca em texto no Git.
- **"Por que a migração é um Job, e não um initContainer da API?"** O initContainer roda em CADA réplica, a cada
  pod novo: corrida entre réplicas e DDL a cada escala. O Job roda uma vez, antes, e falha o deploy se falhar.
- **"Por que o Job tem nome novo a cada versão?"** O template de um Job é imutável; e o nome com o commit vira o
  histórico de qual migração rodou com qual versão.
- **"O que acontece com os dados se o pod do banco morrer? E se apagarem o PVC?"** O pod volta e monta o mesmo disco;
  apagar o PVC (com `Delete`) apaga o disco. Por isso `Retain` e backup.

### Perguntas de entrevista (2.3)

- **"Como você garante deploy sem downtime no Kubernetes?"** Três peças, cada uma para um lado: readiness (o pod novo
  só recebe tráfego quando responde), `maxUnavailable: 0` com `maxSurge` (nunca abaixo da capacidade) e drenagem no
  encerramento (o velho continua atendendo enquanto a remoção se propaga). E medir: aqui, 32 falhas → 0.
- **"Se tem readiness, para que drenagem?"** No encerramento, o SIGTERM e a saída do Service acontecem em paralelo, e
  cada kube-proxy aplica a remoção um pouco depois. Medido: sem drenagem, 11 falhas; com, 0.
- **"Liveness × readiness × startup?"** Liveness reinicia (processo travado); readiness tira do tráfego (não pode
  atender agora); startup protege o boot. Liveness nunca olha dependência, senão um banco fora vira *restart storm*.
- **"Por que você não põe limit de CPU?"** CPU é comprimível; o limit causa *throttling* por janela de 100 ms mesmo
  com o nó ocioso, e isso vira p99 alto. Memória não é comprimível, então tem limit (OOMKill previsível).
- **"Como você escolheu requests e limits?"** Medindo: `memory.peak` e `cpu.stat` do cgroup sob carga. O request
  cobre o pico do boot; o limit tem folga para as rotas caras. Em produção, a partir das métricas (ou do VPA).
- **"O deploy subiu uma versão quebrada. O que acontece?"** Com `maxUnavailable: 0`, nada sai do ar: o pod novo nunca
  fica pronto, os velhos continuam, o `progressDeadlineSeconds` marca o rollout como falho e o pipeline avisa. O
  rollback (`rollout undo`, ou `git revert` em GitOps) reativa o ReplicaSet anterior.
- **"Que `securityContext` você usa?"** Não-root conferível (uid numérico), disco somente leitura, sem capabilities,
  sem escalada de privilégio, seccomp `RuntimeDefault` e sem token da ServiceAccount; com o Pod Security Admission
  no namespace para o API server recusar o que fugir disso.

---

**Anterior:** [Módulo 01 — Observabilidade](01-observabilidade.md) ·
**Próximo:** [Módulo 03 — CI/CD com GitHub Actions](03-ci-cd-github-actions.md)
