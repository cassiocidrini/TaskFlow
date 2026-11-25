# Módulo 02 — Orquestração com Kubernetes

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 25/11/2026
>
> **Status:** 🚧 em construção, etapa **2.2 de 2.6** (a API rodando no cluster, com o Postgres num StatefulSet, a
> configuração em ConfigMap e Secret, e a migração como Job). Cada etapa acrescenta a sua parte a este documento; o mapa completo está em "Roteiro do módulo".
>
> **Onde vive no código:** [`k8s/kind-config.yaml`](../../k8s/kind-config.yaml) (o cluster) ·
> [`k8s/base/`](../../k8s/base/api.yaml) (API e Service) · [`postgres.yaml`](../../k8s/base/postgres.yaml) ·
> [`config.yaml`](../../k8s/base/config.yaml) · [`migrate-job.yaml`](../../k8s/base/migrate-job.yaml) · a imagem que o cluster roda vem do workflow
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
| 2.3 | A API de verdade: probes, recursos, `securityContext`, **rolling update sob carga sem erro** e rollback | 🔜 |
| 2.4 | Kafka, relay e consumers no cluster | 🔜 |
| 2.5 | Ingress, escala automática (HPA) e NetworkPolicy | 🔜 |
| 2.6 | Ambientes com Kustomize (dev × prod) e a segunda metade do CD (GitOps) | 🔜 |

---

## 🏗️ Arquitetura (estado atual: 2.2)

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

namespace taskflow
  ConfigMap taskflow-api (NODE_ENV, LOG_LEVEL, OTEL_SDK_DISABLED)        ← Git
  Secret taskflow-db (password) · Secret taskflow-api (jwt-secret)       ← kubectl create, NUNCA no Git
       │
       ├─► Service postgres (headless) ─► StatefulSet postgres ─► postgres-0 ─► PVC data-postgres-0 (1 GiB) ─► PV (local-path)
       │                                    readiness: pg_isready
       ├─► Job taskflow-migrate-aa4d4a0 ─► prisma migrate deploy (20 migrações) ─► Complete     (1º, com kubectl wait)
       └─► Service taskflow-api (ClusterIP :80) ─► EndpointSlice (IPs dos pods prontos)
                                                  └─► Deployment taskflow-api ─► ReplicaSet ─► 2 pods (um por worker)
                                                        imagem ghcr.io/cassiocidrini/taskflow@sha256:41e6c0e0… (aa4d4a0)
                                                        DATABASE_URL = postgresql://taskflow:$(POSTGRES_PASSWORD)@postgres:5432/taskflow
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

Para apagar tudo: `kind delete cluster --name taskflow`. Num cluster novo, os Secrets precisam ser criados de novo
(não estão no Git).

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | Por ~2 s, o pod que ia morrer apareceu como `READY 1/1` | Sem *readiness probe*, "processo rodando" é tratado como "pronto". Com um Service na frente, chegaria tráfego a um pod que nem subiu | Esperado na 2.1 (o manifesto mínimo); as probes entram na 2.3 |
| 2 | `kubectl describe pod -l …` não trouxe a seção `Events` | No `kubectl` 1.37, o `describe` com seletor de label veio sem os eventos | `kubectl get events -n <ns> --sort-by=.lastTimestamp`: o histórico do namespace inteiro, em ordem. Eventos **expiram** (1 h por padrão): num incidente, colete cedo |
| 3 | `kubectl logs --previous` respondeu `unable to retrieve container logs` | Com o pod parado em `Error`/`CrashLoopBackOff`, o container "atual" **já é** a tentativa que morreu, e o anterior a ela o kubelet já descartou | Pod parado: `kubectl logs` **sem** `--previous`. O `--previous` é para o pod que reiniciou e está `Running` |
| 4 | A mensagem de erro de boot manda conferir o `.env` | Escrita para o desenvolvimento local; num container não existe `.env` | **(2.2)** O texto passou a citar os dois lugares: o `.env` no desenvolvimento, o ConfigMap e o Secret num container |
| 5 | O erro de boot saiu em **texto**, não em JSON | O logger JSON (pino) só assume depois de o Nest subir; um erro antes disso sai no formato padrão do Nest | Registrado (limitações): a linha mais importante de um `CrashLoopBackOff` chega a um agregador sem estrutura |
| 6 | **(2.2)** O `curl` digitado na aba do `port-forward` não executou | O `port-forward` prende o terminal enquanto o túnel está aberto; o texto fica na fila e só roda quando o túnel fecha | O túnel numa aba própria, os testes em outra |

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

---

## 🔄 Como este módulo evoluiu com o projeto

| Antes | Hoje | Por quê |
|---|---|---|
| A imagem publicada no GHCR, sem ninguém para rodá-la | **(2.1)** Um cluster local reproduzível (arquivo versionado, versão fixada) rodando a imagem por digest | O fim do pipeline precisa de um orquestrador: réplicas, troca de versão, tráfego só para o que está pronto |
| A API em `CrashLoopBackOff`, sem configuração nem banco | **(2.2)** Postgres num StatefulSet com volume, ConfigMap no Git e Secrets fora dele, migração como Job, e a API atrás de um Service | O deploy completo de um serviço com estado: a ordem banco → migração → API, e cada tipo de objeto no seu papel |
| A versão do Postgres em três lugares (compose, testes, smoke) | **(2.2)** Quatro, com o manifesto, e o `test-images.spec.ts` vigiando os quatro | O Dependabot não lê manifestos do Kubernetes: sem o teste, o cluster ficaria numa versão e o resto em outra |
| Módulo planejado "para um ambiente Linux dedicado" | Feito no Linux de desenvolvimento, com kind | O kind roda o Kubernetes oficial em containers: não precisa de máquina dedicada |

---

## 🚧 Limitações e próximos passos

- **Sem probes, recursos nem `securityContext`:** o pod é considerado pronto assim que o processo inicia, sem limite
  de CPU/memória, e sem exigir o não-root que a imagem já oferece (2.3).
- **Secrets criados à mão:** num cluster novo, alguém precisa rodar o `kubectl create secret` (e guardar os valores
  fora). O caminho de produção é o External Secrets Operator lendo de um cofre, ou Sealed Secrets/SOPS no Git.
- **Postgres sem backup, sem réplica e como root:** um pod, um disco local, `RECLAIM POLICY: Delete`, e a imagem
  oficial rodando com o usuário padrão. Em produção, um banco gerenciado (ou um operador como o CloudNativePG).
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
- [ ] Probes, recursos, `securityContext` e rolling update sem erro (2.3)
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

---

**Anterior:** [Módulo 01 — Observabilidade](01-observabilidade.md) ·
**Próximo:** [Módulo 03 — CI/CD com GitHub Actions](03-ci-cd-github-actions.md)
