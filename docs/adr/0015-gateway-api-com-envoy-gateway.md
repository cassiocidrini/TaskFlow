# ADR-0015: A entrada do cluster pela Gateway API, com o Envoy Gateway

- **Status:** Aceito
- **Decisão:** 26/11/2026 (Módulo 02, etapa 2.5) · **Registro:** 26/11/2026
- **Relacionados:** [Módulo 02](../modules/02-kubernetes.md) · [`k8s/base/gateway.yaml`](../../k8s/base/gateway.yaml) ·
  [Módulo 06](../modules/06-seguranca-owasp.md) (o IP do cliente atrás do proxy)

## Contexto

Até a 2.4, a API só era alcançável de fora do cluster por `kubectl port-forward`: um túnel de depuração, preso a um
pod, sem balanceamento. Faltava a **entrada**, o componente que recebe o tráfego externo, escolhe a rota pelo host e
pelo caminho, e entrega aos pods prontos.

O roteiro original do módulo dizia "Ingress". Ao chegar a esta etapa, o cenário era outro:

- **O objeto `Ingress` está congelado:** continua na API do Kubernetes, mas não recebe recurso novo. O que ele não
  expressa (divisão de tráfego por peso, roteamento por header, TCP/UDP, políticas por rota) vira **anotação**
  específica de cada controller, que não é portável e não é validada.
- **O controller de Ingress mais usado, o `ingress-nginx`, foi aposentado pelo próprio projeto Kubernetes** (anúncio
  no fim de 2025, manutenção encerrada em 2026).
- **A Gateway API é a sucessora oficial** (GA desde 2023), mantida pelo SIG Network, com testes de conformidade que
  cada implementação precisa passar.

O kind não tem balanceador de nuvem: um Service `type: LoadBalancer` ficaria `<pending>` para sempre.

## Decisão

**A entrada é a Gateway API, implementada pelo Envoy Gateway, com o IP de LoadBalancer dado pelo cloud-provider-kind.**
Cada ferramenta tem **um papel só**:

| Peça | Versão | Papel | O que NÃO faz |
|---|---|---|---|
| CRDs da Gateway API (canal **standard**) | v1.6.3 | Os tipos `GatewayClass`, `Gateway`, `HTTPRoute`, do projeto oficial | — |
| Envoy Gateway | v1.10.0 | A implementação: lê os objetos e configura um Envoy por Gateway | Não é dono dos CRDs da Gateway API |
| cloud-provider-kind | v0.12.0 | Dá IP aos Services `LoadBalancer`, como uma nuvem | Gateway e Ingress **desligados** (`--gateway-channel disabled --enable-default-ingress=false`) |

**Os papéis da Gateway API viram objetos diferentes**, cada um de quem decide sobre ele:

| Objeto | Dono típico | Aqui |
|---|---|---|
| `GatewayClass` | Plataforma: qual implementação | `envoy` (cluster) |
| `Gateway` | Plataforma: endereço, porta, hosts aceitos, quem pode pendurar rotas | `taskflow`: HTTP 80, só `taskflow.local`, rotas só do mesmo namespace |
| `HTTPRoute` | Time da aplicação, no namespace dele | `taskflow-api`: tudo de `taskflow.local` para o Service da API |

**Canal standard, e não experimental.** O canal experimental traz recursos e campos em alfa, que podem mudar de forma
incompatível; o TaskFlow usa só `Gateway` e `HTTPRoute`, estáveis. O próprio projeto Gateway API instala uma
`ValidatingAdmissionPolicy` (`safe-upgrades`) que **recusa** CRDs experimentais por cima de standard.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **`Ingress` com `ingress-nginx`** | Controller aposentado; o objeto congelado, com o que falta resolvido por anotações próprias do controller |
| **`Ingress` com outro controller** (Traefik, HAProxy) | Resolve o controller, não o objeto: as mesmas anotações não portáveis, num modelo que o Kubernetes não evolui mais |
| **A Gateway API do próprio cloud-provider-kind** (ele implementa `Gateway` e `HTTPRoute`, também com Envoy) | Feito para testes locais; amarraria a entrada a uma ferramenta que só existe no kind. O Envoy Gateway é o mesmo que rodaria num cluster de verdade |
| **Outras implementações da Gateway API** (Istio, Cilium, NGINX Gateway Fabric, Traefik) | Todas passam na conformidade; o Envoy Gateway é o projeto da CNCF dedicado só a isso, sem trazer uma malha de serviço (Istio) ou trocar o CNI (Cilium) |
| **Recriar o cluster com `extraPortMappings`** (as portas 80/443 do nó publicadas no host) | Exige recriar o cluster (Secrets e banco de novo) e não mostra o Service `LoadBalancer`, que é como a entrada funciona numa nuvem |
| **Canal experimental** dos CRDs (o que o `install.yaml` do Envoy Gateway traz) | Risco de mudança incompatível sem ganho: nada experimental é usado. E a política `safe-upgrades` o recusa por cima do standard |

## Consequências

**Positivas**
- A entrada é a de um cluster real: Service `LoadBalancer` com IP, Envoy na frente, host e rota declarados em objetos
  validados pelo API server, e não em anotações.
- A separação de papéis permite que o time da aplicação mude rotas sem tocar no Gateway, e que a plataforma restrinja
  quem pendura rotas nele (`allowedRoutes: Same`).
- Trocar a implementação (Envoy Gateway por outra) não muda os manifestos do TaskFlow, só a `GatewayClass`.

**Negativas**
- **Três instalações de plataforma fora do repositório**, cada uma por versão e checksum, em ordem (Módulo 02, "Como
  reproduzir"). Em GitOps (2.6), viram referências versionadas.
- **Reaplicar o `install.yaml` do Envoy Gateway mostra 10 `denied request`** nos CRDs da Gateway API: é a política
  `safe-upgrades` protegendo o canal standard. O resto do arquivo é aplicado. Separar de vez (o chart sem os CRDs) é
  da 2.6.
- **Um proxy a mais no caminho:** +0,4 ms de latência média medidos (1,15 ms pela borda × 0,76 ms direto no Service),
  e o IP do cliente passa a ser o do Envoy. Isso exigiu o `TRUST_PROXY_HOPS` na app e a NetworkPolicy na rede
  (Módulo 06).
- **Só HTTP, sem TLS:** o listener é `HTTP` na porta 80. Certificado (cert-manager + listener HTTPS) fica para depois.

## Revisitar quando

- **O cluster for de uma nuvem:** o cloud-provider-kind sai, e o balanceador da nuvem entra no lugar; os manifestos do
  TaskFlow não mudam.
- **Precisar de TLS na borda:** listener HTTPS no Gateway, com o certificado de um `Secret` gerido pelo cert-manager.
- **Precisar de um recurso que só existe no canal experimental:** a troca de canal é uma decisão explícita, com a
  política `safe-upgrades` removida de propósito, e um ADR novo.

## Evidência

- `GatewayClass envoy` `ACCEPTED`, `Gateway taskflow` `PROGRAMMED` com o IP `172.19.0.5`; `200` para
  `Host: taskflow.local` e `404` do próprio Envoy para `outro.local`. [Módulo 02](../modules/02-kubernetes.md),
  "Resultados", 2.5.
- O conflito de dono dos CRDs (`Apply failed with conflicts ... "cloud-provider-kind"`) e a recusa da política
  `safe-upgrades`, resolvidos com cada ferramenta num papel só e os CRDs oficiais v1.6.3.
- Rollout da API com a carga entrando pelo Envoy: 0 falhas em 17.450 requisições.
