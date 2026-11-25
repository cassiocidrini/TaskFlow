# Módulo 14 — Uma API para web e apps

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 25/11/2026
>
> **Status:** ✅ concluído (14.1 a 14.8). Comece por "A política em uma página", logo abaixo do objetivo: ela liga cada
> decisão à etapa e ao ADR que a sustentam.
>
> **Onde vive no código:** [`src/common/client/`](../../src/common/client/client-info.ts) (headers, parser de versão,
> middleware e `@AppClient()`) · [`request-span.ts`](../../src/common/telemetry/request-span.ts) ·
> [`app.setup.ts`](../../src/app.setup.ts) (registro, CORS e Swagger) ·
> [`logger.options.ts`](../../src/common/logging/logger.options.ts) (cliente no log de acesso) · painel "Clientes" em
> [`taskflow-api.json`](../../grafana/dashboards/taskflow-api.json) · versão mínima em
> [`version-gate.middleware.ts`](../../src/common/client/version-gate.middleware.ts),
> [`version-policy.service.ts`](../../src/common/client/version-policy.service.ts) e o comando
> [`src/app-version.ts`](../../src/app-version.ts) · contrato em [`docs/api/openapi.json`](../api/openapi.json),
> [`scripts/openapi/`](../../scripts/openapi/snapshot.ts) e [`api-contract.yml`](../../.github/workflows/api-contract.yml) ·
> prazo em [`due.dto.ts`](../../src/modules/tasks/dto/due.dto.ts), [`task-event.upcasters.ts`](../../src/modules/tasks/infrastructure/task-event.upcasters.ts) e
> [`deprecation.ts`](../../src/common/deprecation/deprecation.ts) · idempotência em
> [`src/common/idempotency/`](../../src/common/idempotency/idempotency.store.ts) · flags em
> [`src/modules/feature-flags/`](../../src/modules/feature-flags/feature-flag.rules.ts) e o comando
> [`src/feature-flag.ts`](../../src/feature-flag.ts) · rollout medido em
> [`task-list.rollout.ts`](../../src/modules/tasks/task-list.rollout.ts)

---

## 🎯 Objetivo

Preparar a API para dois tipos de cliente com regras de atualização opostas: o **front web**, que muda a cada deploy,
e os **apps** (iOS e Android), que mudam quando o usuário quer.

**Por que importa:** na web, um deploy atualiza todo mundo na próxima recarga. No celular, a versão lançada há 8
meses continua instalada, e continua chamando a API. Toda mudança de contrato passa a ter dois lados: a API de hoje
e todos os apps que ainda estão por aí. As perguntas que o módulo responde:

1. **Quem está chamando?** (14.1)
2. **Como bloquear uma versão quebrada?** (14.2)
3. **Como mudar a API sem quebrar quem não atualizou?** (14.3, 14.4)
4. **Como sobreviver à rede ruim do celular, que repete requisições?** (14.5)
5. **Como ligar e desligar funcionalidades sem publicar versão nova na loja?** (14.6, 14.7)
6. **Qual é a regra que junta tudo isso?** (14.8)

---

## 📌 A política em uma página

A resposta para *"como vocês versionam a API?"* ([ADR-0012](../adr/0012-versionamento-da-api-e-janela-de-suporte.md)):
**sem versão na URL por padrão.** A API evolui só com mudanças compatíveis, o cliente é um leitor tolerante (ignora o
que não conhece), e o que precisa quebrar passa por depreciação com prazo. `/v2` só para redesenho de um recurso.

**A janela de suporte:**

| Regra | Valor |
|---|---|
| Versões do app suportadas | As lançadas nos **últimos 6 meses** |
| Subir a versão mínima | Só até uma versão lançada há 6 meses ou mais; bug grave ou de segurança: **na hora** |
| Aviso de depreciação | `Sunset` pelo menos **90 dias** depois do `Deprecation` (o CI confere) |
| Web | Sem janela; abas abertas recebem a versão mínima do web |

**O mapa de decisão: "o que eu uso para esta mudança?"**

| Mudança | Ferramenta | Etapa · ADR |
|---|---|---|
| Campo ou rota novo, opcional | Só fazer: o oasdiff confirma que é compatível | 14.3 |
| Renomear ou mudar o formato de um campo | Expand → `Sunset` → versão mínima → contract (código e banco em deploys separados) | 14.4 · [0008](../adr/0008-depreciacao-e-remocao-de-campos-da-api.md) |
| Funcionalidade nova arriscada | Feature flag, rollout por variante com critério escrito antes, e data para a flag sair | 14.6, 14.7 · [0010](../adr/0010-feature-flags-proprias.md), [0011](../adr/0011-criterio-de-avanco-do-rollout.md) |
| Versão do app quebrada | Versão mínima → 426, sem deploy | 14.2 |
| Operação que não pode duplicar | `Idempotency-Key`, com a chave na transação do efeito | 14.5 · [0009](../adr/0009-idempotencia-de-requisicoes-na-transacao-do-efeito.md) |
| Redesenho de um recurso | `/v2` em paralelo, durante a janela de suporte | [0012](../adr/0012-versionamento-da-api-e-janela-de-suporte.md) |

**O que o CI garante, e o que é decisão** (a lição da 14.4b): o CI pega a quebra **acidental** (o oasdiff sobre o
contrato versionado) e o aviso curto demais (o teste da lista de campos depreciados). A quebra **planejada** é decidida
pelos critérios: o `Sunset`, a versão mínima, a métrica de uso.

---

## 🗺️ Roteiro do módulo

| Etapa | O que entrega | Status |
|---|---|:-:|
| **14.1** | Identificação do cliente: `X-Platform` e `X-App-Version` no request, no span, no log e numa métrica com cardinalidade limitada | ✅ |
| **14.2** | Versão mínima por plataforma, configurável sem deploy (tabela + cache de 30 s + `npm run app-version` com auditoria): `426` + `APP_UPDATE_REQUIRED`; aviso de atualização recomendada | ✅ |
| **14.3** | Contrato versionado (`docs/api/openapi.json`) conferido no CI, e mudanças **incompatíveis** classificadas pelo oasdiff, liberadas só com a label `breaking-change` | ✅ |
| **14.4a** | **Expand** do `dueDate` → `due { at, timezone }`: os dois formatos aceitos e devolvidos, `Deprecation`/`Sunset`, métrica de uso por versão, `TaskCreated` v2 com *upcaster*, read model com expand + backfill | ✅ |
| **14.4b** | **Contract**, passo 1: o `dueDate` sai da API; o código para de gravar e de ler a `due_date`; backfill final; ADR-0008 (política de depreciação) | ✅ |
| **14.4c** | **Contract**, passo 2 (outro deploy): `DROP COLUMN due_date` com `lock_timeout` e checagem anti-perda; campos sempre presentes das respostas documentados como obrigatórios | ✅ |
| **14.5** | `Idempotency-Key` no `POST /tasks`: a nova tentativa devolve a mesma resposta; a chave gravada na mesma transação da tarefa (ADR-0009) | ✅ |
| **14.6** | Feature flags em módulo próprio (ADR-0010): kill switch, restrições de plataforma e versão, lista de usuários, porcentagem por bucket; `GET /me/features`; `npm run feature-flag` com auditoria | ✅ |
| **14.7** | `stats` do projeto na listagem atrás da flag `task-list-with-stats`; métricas por variante, painel e 2 alertas testados; critério de avanço no ADR-0011 | ✅ |
| **14.8** | A política que junta tudo (ADR-0012): sem versão na URL por padrão, janela de suporte de 6 meses, 90 dias de aviso conferidos no CI, o mapa de decisão | ✅ |

---

## 🏗️ Arquitetura

O caminho de uma requisição de app, com a etapa de cada camada:

```text
request (app ou web)
  │
  ├─ correlationId (Módulo 01)
  ├─ clientInfo (14.1) ─────── plataforma + versão → req.appClient, span do request, log, taskflow_app_requests_total
  ├─ helmet · cors (expõe X-App-Update, Deprecation/Sunset/Link, Idempotent-Replayed)
  ├─ pino-http (log de acesso, com o cliente)
  ├─ VersionGate (14.2) ────── abaixo da mínima → 426 APP_UPDATE_REQUIRED · abaixo da recomendada → X-App-Update
  │                              (política em app_version_policies, cache 30 s, fail-open)
  ├─ guards: JWT, throttler
  ├─ validação do DTO ─────── forbidNonWhitelisted; due { at com fuso, timezone IANA } (14.4)
  └─ handler
       ├─ GET  /me/features (14.6) ───────────── FeatureFlags (porta) → Postgres (cache 5 s, fail-closed): só o resultado
       ├─ GET  /projects/:id/tasks (14.7) ─────── flag task-list-with-stats → stats na 1ª página + métrica por variante
       └─ POST /projects/:id/tasks (14.5) ─────── Idempotency-Key: repete a resposta guardada, ou grava a chave
                                                   NA transação do TaskCreated (evento v2 + outbox + chave)

Leitura do Event Store: upcaster TaskCreated v1 → v2 (14.4), para sempre
CI: docs/api/openapi.json (14.3) · oasdiff: incompatível sem a label = vermelho · aviso de depreciação ≥ 90 dias (14.8)
Operação: npm run app-version · npm run feature-flag (com auditoria) · painéis Clientes e Rollout · alertas TaskListStats*
```

---

## 🧠 Conceitos

### Web × app: por que a versão do cliente importa

| | Front web | App (iOS/Android) |
|---|---|---|
| Quem decide atualizar | Você (o deploy) | O usuário (ou a loja, quando ele deixa) |
| Quanto tempo uma versão vive | Até a próxima recarga | Meses; às vezes anos |
| Publicar uma correção | Minutos | Horas a dias (revisão da loja) |
| Consequência para a API | Contrato e cliente mudam juntos | Toda versão ainda instalada é um cliente a manter |

Por isso o app precisa **se identificar**: sem saber quem chama, a API não consegue avisar um app quebrado, escolher o
formato de resposta que ele entende, nem medir quantos usuários ainda estão numa versão antes de deixar de suportá-la.
O front web também manda os headers: com a versão do build, dá para pedir "recarregue a página" pelo mesmo mecanismo.

### O contrato dos headers

| Header | Formato | Ausente ou inválido |
|---|---|---|
| `X-Platform` | `ios` · `android` · `web` (sem diferenciar maiúsculas: os apps mandam `iOS`) | `unknown` |
| `X-App-Version` | `MAJOR.MINOR.PATCH`, só números, até 4 dígitos por parte, sem zero à esquerda | `null` |

**Nunca 400.** Identificar o cliente é diagnóstico e política, e não pode derrubar uma requisição legítima: o mesmo
princípio do `X-Correlation-Id` ([Módulo 01](01-observabilidade.md)). curl, integrações e um front antigo seguem
funcionando como cliente desconhecido.

**Versão de loja, não semver completo.** App Store e Play Store usam `x.y.z`, sem pré-release (`-beta.1`) nem metadata
(`+build.5`); o número de build é outro campo. Por isso um parser próprio de 20 linhas
([`app-version.ts`](../../src/common/client/app-version.ts)) em vez do pacote `semver`, cujo trabalho é quase todo nas
partes que não existem aqui. A comparação é **número a número**: como texto, `"1.10.0" < "1.9.0"`, e a versão mínima da
14.2 bloquearia justamente o app mais novo.

### Não é segurança, e o desenho assume isso

O header é controlado pelo cliente: qualquer um manda `X-App-Version: 99.0.0` com o curl. Então a versão serve para
**compatibilidade e experiência** (avisar o app antigo, escolher o formato de resposta, medir adoção) e **nunca para
autorização**. A frase para a entrevista: *a versão mínima protege o usuário de um app quebrado, não a API de um
atacante*. Provar que a chamada vem do app legítimo, sem modificação, é outro problema (*app attestation*: App Attest
no iOS, Play Integrity no Android), registrado nas limitações.

O `@AppClient()` e o `@CurrentUser()` parecem iguais (decorators que injetam algo do request), mas são opostos: o
usuário vem de um token **assinado** e é identidade; o cliente vem de headers **livres** e é só uma pista.

### Cardinalidade: cada destino recebe uma forma

| Destino | O que entra | Por quê |
|---|---|---|
| Span do request | `taskflow.client.platform`, `taskflow.client.app_version` (completa) | Trace aceita cardinalidade alta: dá para achar no Jaeger os traces da `2.14.7` |
| Log de acesso | `client: { platform, appVersion }` (completa) | O suporte filtra "erros do Android 2.13" |
| Métrica `taskflow_app_requests_total{platform, app_version}` | `MAJOR.MINOR`; `none` sem versão; `other` acima de 99 | Cada combinação de labels é uma série no Prometheus, para sempre |
| `userId` | Em lugar nenhum das métricas | Uma série por usuário derruba o Prometheus |

A métrica existe para responder **"quantos clientes ainda estão abaixo da versão X?"**, a pergunta obrigatória antes de
subir a versão mínima na 14.2. O PATCH não muda nenhuma decisão de compatibilidade, então não vira label. E como o
valor vem do cliente, alguém poderia mandar mil versões inventadas e criar mil séries: o truncamento e o teto contêm
isso (no pior caso, 4 plataformas × ~10 mil séries). É contenção, não a defesa definitiva, que seria aceitar como
label só os releases conhecidos (limitações).

O log e o span recebem o valor **já validado** pelo middleware, nunca o header cru: uma "versão" com quebra de linha
não entra no log (*log injection*, OWASP A09).

### Em qual span gravar: o do request, não o ativo

Dentro de um middleware Express, o span **ativo** é o que o `instrumentation-express` abre para o próprio middleware
(`middleware - clientInfoMiddleware`). O primeiro teste ao vivo mostrou os atributos do cliente lá, e não no `GET /`.
O `correlation.id` do Módulo 01 sempre esteve no mesmo lugar (documentado como peculiaridade). A correção vale para os
dois: [`currentRequestSpan()`](../../src/common/telemetry/request-span.ts) pega o span do request no `rpcMetadata` que o
`instrumentation-http` guarda no contexto, o mesmo que o `RouteTelemetryGuard` usa para a rota (problema 1).

---

### Middleware, e não interceptor nem guard

A ordem de execução no Nest decide:

```text
middleware Express (app.use) → middleware de módulo → guards → interceptors → pipes → handler
```

O cliente precisa existir **antes dos guards**: na 14.2, o app antigo tem que receber o "atualize" mesmo deslogado
(senão ele veria um 401 e o usuário tentaria logar de novo, num app que não funciona mais), e o log de acesso de uma
requisição barrada pelo JWT também registra quem era. Um interceptor rodaria depois dos guards; um guard não roda
para rota inexistente.

**O contador é criado numa fábrica** (`createClientInfoMiddleware()`, chamada no `configureApp`), e não ao importar o
arquivo. A API de métricas do OpenTelemetry não tem provider "proxy" como a de traces: um `getMeter` executado antes
de o SDK registrar o provider devolve um contador que nunca exporta. Testado por mutação: com o contador criado no
import, os testes que contam requisições falham.

### Versão mínima (14.2): bloquear um app quebrado sem esperar deploy

**O cenário.** A versão 2.9 do app grava datas erradas. A correção (2.10) está na loja, mas quem tem a 2.9 instalada
continua com ela. A API precisa dizer a esse app: *pare, atualize*. E isso não pode esperar o próximo deploy da API.

| Situação | Resposta |
|---|---|
| Abaixo da **mínima** da plataforma | **426** `{ statusCode, error, code: "APP_UPDATE_REQUIRED", message, platform, minVersion }` |
| Abaixo da **recomendada** (e na mínima ou acima) | A resposta normal + `X-App-Update: recommended` e `X-App-Recommended-Version` (*soft update*: um aviso que dá para fechar) |
| Sem versão, plataforma `unknown` ou sem política | Passa |
| `/health/*` | Passa, sem nem consultar a política |

Vale para o **web** também: abaixo da mínima, o front recebe 426 e faz "recarregue a página".

**Onde a política mora: tabela + cache curto.**

| Opção | Por que sim ou não |
|---|---|
| Variável de ambiente | ❌ Mudar exige restart ou deploy, justamente o que não pode |
| **Tabela `app_version_policies` + cache de 30 s** | ✅ Muda sem deploy, vale para todas as réplicas em até 30 s, sem infraestrutura nova |
| AWS AppConfig / SSM Parameter Store | A escolha em produção na AWS (versões, rollback, validação, deploy gradual da configuração). Aqui, uma dependência a mais por um valor que o banco já guarda |
| Só no app (Firebase Remote Config) | Complementa, não substitui: **o app antigo que você quer bloquear pode não ter a checagem**. O 426 do servidor é a rede de segurança |

**O cache, e o que ele custa.** Sem cache, toda requisição faria uma query a mais para ler um valor que muda uma vez
por mês. Com ele, uma mudança leva até `APP_VERSION_POLICY_CACHE_TTL_MS` (30 s) para valer em todas as réplicas, e
cada réplica pode aplicar a mudança num instante diferente dentro dessa janela. Medido: a mínima baixada pelo comando
passou a valer na API depois de exatos 30 s, sem reinício. Dois detalhes de implementação que valem a pergunta:

- **Uma leitura por vez:** quando o cache vence, as requisições que chegam juntas esperam a MESMA consulta (sem *cache
  stampede*). Testado: 20 requisições simultâneas, 1 consulta; sem isso (mutação), 20.
- **Fail-open com o último valor conhecido:** se a leitura falhar, vale a política anterior por mais um ciclo (e o
  banco não é martelado a cada requisição); se nunca houve uma, tudo passa. O contrário (*fail-closed*) bloquearia
  TODOS os apps por uma falha de leitura de configuração. Testado: sem o "último conhecido" (mutação), um bloqueio
  vigente seria esquecido na primeira falha do banco.

**Quem não se identifica passa, e isso não é um furo.** Um app que quisesse escapar do bloqueio era só não mandar o
header, e um atacante manda a versão que quiser (14.1). A versão mínima protege o **usuário** de um app quebrado; a
API se protege de atacantes com autenticação, autorização e validação.

**Por que 426, com a ressalva.** O `426 Upgrade Required` foi criado para upgrade de **protocolo** (a RFC 9110 manda
incluir o header `Upgrade`), mas é a convenção de mercado para "atualize o app". O app deve checar o **`code`** do
corpo, que é nosso e estável; o status é só a primeira pista. Alternativas como `400` ou `403` com o mesmo `code`
funcionariam igual; o que não pode é o app decidir só pelo status.

**Mudar a política: um comando, não um endpoint.** A API não tem papéis de usuário (todo usuário é dono dos próprios
projetos), e criar um "admin" só para isto abriria mais superfície do que resolve: quem roda o comando já tem acesso ao
banco, que é o controle de acesso real. O comando ([`app-version.ts`](../../src/app-version.ts)):

- valida o formato e a regra **mínima ≤ recomendada** (as mesmas regras viram `CHECK` no banco, para quem escrever
  direto na tabela; a comparação no SQL é como array de inteiros, então `1.10.0 > 1.9.0` lá também);
- grava numa transação, sob advisory lock, a política e a auditoria (`app_version_policy_changes`: antes, depois,
  quem, quando). Responde *"quem bloqueou o iOS 2.9, e quando?"*;
- `--dry-run` mostra o antes → depois sem gravar; remover as duas versões apaga a política.

**A regra operacional:** antes de subir a mínima, olhe o painel **Clientes** (14.1). Ele diz quantas requisições ainda
vêm de versões abaixo dela, e cada uma vai virar uma tela de "atualize o app". Depois de subir,
`taskflow_app_update_required_total{platform}` conta os 426, e o log de acesso registra cada um como `warn`, com o
cliente.

**Onde roda: middleware de módulo, depois do log e antes dos guards.** A ordem do Nest é `app.use()` → middlewares de
módulo (o `pino-http` do `nestjs-pino` é um deles) → guards. Como `app.use()`, o bloqueio respondia antes de o log de
acesso existir, e o 426 **não aparecia em log nenhum** (problema 3). Registrado pelo `VersionPolicyModule`, que vem
depois do `LoggerModule`, ele roda depois do log e ainda antes do JWT.

### O contrato da API no repositório (14.3)

**O problema.** Renomear um campo da resposta, tornar obrigatório um campo de entrada, remover uma rota: os testes
passam (eles testam o código novo), e quem quebra é o **app instalado**, que só recebe correção quando o usuário
atualizar. Na web isso quase não existe; com apps, é o risco principal de toda mudança na API.

**Camada 1: o snapshot (toda mudança de contrato é vista).** O documento OpenAPI é um arquivo versionado,
[`docs/api/openapi.json`](../api/openapi.json). O `npm run openapi:check` (no job `quality` do CI) gera o documento do
código e falha se ele não bate com o arquivo, apontando a linha. Mudar a API exige `npm run openapi:generate` no mesmo
PR: a mudança de contrato aparece no diff, num arquivo que quem revisa lê. Três detalhes:

- **Gerado do `dist/`**, não do TypeScript: o plugin do Swagger (`nest-cli.json`), que completa os DTOs a partir dos
  tipos e do `class-validator`, só roda no `nest build`. Gerado pelo Jest ou pelo `ts-node`, o snapshot seria
  diferente do contrato que a API serve. O documento sai sem banco e sem servidor (~100 ms).
- **Uma fonte só:** `buildOpenApiDocument(app)` monta o documento para o `/docs` e para o snapshot.
- **Chaves ordenadas, arrays não:** a ordem das chaves muda quando se move um método de lugar (diff falso); a ordem dos
  arrays é informação (parâmetros, valores de `enum`). Dois processos geram o mesmo hash.

**Camada 2: o que quebra quem não atualizou.** O snapshot não distingue acrescentar um campo opcional (seguro) de
remover um campo da resposta (quebra). O **oasdiff** compara o contrato da base do PR com o do PR e lista as mudanças
incompatíveis; o workflow [`api-contract.yml`](../../.github/workflows/api-contract.yml) falha se houver alguma, a menos
que o PR tenha a label **`breaking-change`** (a decisão fica explícita e registrada no PR). Workflow separado porque
precisa rodar de novo quando a label muda, sem disparar os jobs do CI. Localmente: `npm run openapi:diff`, com a
mesma imagem, fixada por tag e digest (`tufin/oasdiff:v1.37.0@sha256:…`, Módulo 03, E.2).

**A assimetria que define o que é incompatível.** A API **recebe** dados do app e **devolve** dados para ele, e as
regras se invertem (o mesmo raciocínio do leitor tolerante do Módulo 13: seja exigente no que envia, tolerante no que
recebe):

| Mudança | Na resposta (o app lê) | Na requisição (o app envia) |
|---|---|---|
| Campo novo | ✅ Seguro: o app antigo ignora | ✅ Se opcional; ❌ se obrigatório (o app antigo não manda) |
| Campo removido | ❌ O app antigo pode depender dele | ✅ Se a API passa a ignorá-lo |
| Opcional → obrigatório | ✅ (a API garante mais) | ❌ (o app antigo não manda) |
| Limite mais restrito (`maxLength` menor, `enum` menor) | ✅ | ❌ O app antigo aceita o valor na tela e a API recusa |
| Valor novo num `enum` | ❌ Um app com `switch` exaustivo pode quebrar | ✅ |
| Rota removida | ❌ | ❌ |

Oito casos da tabela foram conferidos com o oasdiff (ver "Resultados"). O de `maxLength` é o menos intuitivo: diminuir
o tamanho máximo de um campo de entrada parece inofensivo, mas o app antigo deixa o usuário digitar 100 caracteres e a
API passa a recusar com 400. E o de `enum` na resposta, o mais esquecido: o próprio oasdiff explica que *o servidor
pode devolver um valor que o contrato anterior excluía* (se a lista é feita para crescer, declara-se com
`x-extensible-enum`, e o app trata o valor desconhecido).

**E quando a mudança incompatível é necessária?** Não se faz de uma vez: **expand/contract** (14.4). Acrescenta-se o
novo (compatível), mantém-se o antigo enquanto houver apps que o usam, e remove-se depois que a versão mínima (14.2)
exclui esses apps. Mesmo esse último passo pode passar sem a label: o oasdiff aceita, por desenho, remover o que foi
depreciado antes (ver o contract, a seguir).

### Expand/contract (14.4): mudar um campo sem quebrar quem não atualizou

**Por que mudar.** O `dueDate` é um instante (`2026-12-31T23:59:59Z`) e não diz em que fuso o usuário pensa. Para um
lembrete de "vence **hoje**", isso importa: 23h em São Paulo já é o dia seguinte em UTC. O formato novo guarda os dois:

```json
"due": { "at": "2026-12-31T23:59:59-03:00", "timezone": "America/Sao_Paulo" }
```

A API devolve o `at` em UTC (`2027-01-01T02:59:59.000Z`): o instante mais o fuso reconstroem a hora local. O
`timezone` é um nome **IANA**, validado pelo `Intl` do Node; um offset (`-03:00`) é recusado, porque muda no horário
de verão e o nome não. E o `at` precisa ter fuso explícito: `2026-12-31T23:59:59` sem `Z` nem offset é ambíguo.

**Por que não trocar de uma vez.** Os apps instalados mandam e leem `dueDate`. Trocar direto quebraria todos (e o
check da 14.3 bloquearia o PR). O caminho tem três fases, em PRs e momentos diferentes:

| Fase | O que acontece | Compatível? |
|---|---|---|
| **Expand** (14.4a) | A API aceita e devolve OS DOIS formatos; o antigo é marcado como depreciado; mede-se quem ainda o usa | ✅ O oasdiff confirmou: 0 erros, 6 mudanças informativas (`dueDate` depreciado em 3 lugares, `due` novo em 3) |
| Transição | Os apps novos usam `due`; a métrica de uso do `dueDate` cai, versão por versão | — |
| **Contract** (14.4b, 14.4c) | Versão mínima acima da última que manda `dueDate`; o campo sai da API (14.4b) e a coluna sai do banco, em outro deploy (14.4c) | Incompatível para quem não atualizou, mas o oasdiff classificou como **informativo** (problema 11): a depreciação anunciada fez o trabalho |

**A entrada aceita um OU outro.** O `dueDate` vira `due { at, timezone: null }` na borda (no controller, numa função
só), e daqui para dentro só existe `due`. Os dois juntos = 400: aceitar os dois exigiria escolher qual vence quando
divergem, e "aceitar se forem iguais" esconderia um bug no app.

**O fuso do formato antigo é `null`, nunca um palpite.** Inventar `UTC` ou `America/Sao_Paulo` seria gravar como fato
o que ninguém disse, a mesma regra do `actorId` dos eventos legados (Módulo 05). Quem usar o prazo (o lembrete) trata
o `null` com o fuso do usuário.

**A saída devolve os dois.** `dueDate` (com `deprecated: true` no OpenAPI) e `due`: o app antigo continua lendo o que
lia, o novo lê o `due`, inclusive da MESMA tarefa (o E2E cria pelo formato novo e confere o `dueDate` na listagem).

**Sinalizar e medir a depreciação.** Quando a requisição usa o `dueDate`, a resposta traz `Deprecation: @<epoch>`
(RFC 9745), `Sunset: <data>` (RFC 8594) e `Link` com `rel="deprecation"`, expostos pelo CORS. E conta
`taskflow_deprecated_field_usage_total{field, platform, app_version}`, com a versão `MAJOR.MINOR` da 14.1 (é o primeiro
handler a usar o `@AppClient()`). É essa métrica que diz quando o contract é seguro: *"a última versão que manda
`dueDate` é a 2.13; mínima em 2.14; então remove"*. O limite: dá para medir quem **envia** o campo, não quem **lê**.
Por isso o critério final é a versão mínima (14.2), e não só a métrica.

**O evento de domínio muda de versão, e os gravados não são reescritos.** O `TaskCreated` passou para o v2 (`due`). O
Event Store é append-only e o histórico é a fonte da verdade, então os v1 continuam gravados como estão. Quem muda é a
**leitura**: o [*upcaster*](../../src/modules/tasks/infrastructure/task-event.upcasters.ts), chamado pelo
`toDomainEvent` (o único caminho de leitura: repositório, histórico e replay), converte o v1 `{ dueDate }` no v2
`{ due: { at, timezone: null } }` pelo `schemaVersion` do envelope (Módulo 0.2). Evento sem envelope conta como v1.
Versão MAIS NOVA que o código (um deploy revertido) falha alto, em vez de ser lida adivinhando. O agregado, as
projeções e o replay só conhecem o v2.

**O banco: nunca `RENAME COLUMN`.** Durante um deploy, a versão anterior da API ainda está no ar e lê a coluna velha.
O read model segue as mesmas três fases:

1. **expand** (migração): `ADD COLUMN due_at, due_timezone`, aceitando NULL e sem default, o que no Postgres só muda
   metadados (sem reescrever a tabela nem segurar lock longo). A projeção grava nas colunas novas E na antiga;
2. **backfill** (migração separada): `UPDATE ... SET due_at = due_date WHERE due_at IS NULL`, sem inventar fuso;
3. **contract**, em DOIS deploys: na 14.4b o código para de gravar e de ler a `due_date` (e o backfill roda uma última
   vez); na 14.4c, a coluna sai. Juntos, a versão anterior, ainda no ar durante o deploy e ainda gravando na
   `due_date`, quebraria a cada tarefa criada.

A armadilha do backfill: as migrações rodam **antes** do código novo subir, então durante o deploy a versão anterior
ainda cria linhas só com `due_date`, depois do backfill. Duas defesas: o backfill é **idempotente** (o contract o
repete antes de remover a coluna) e, durante a transição, a leitura usa **`due_at ?? due_date`**.

**O contract (14.4b): o que decide, e o que o CI vê.** A remoção do `dueDate` só é segura com os três critérios do
[ADR-0008](../adr/0008-depreciacao-e-remocao-de-campos-da-api.md): o `Sunset` passou, a versão mínima está acima de
toda versão que manda o campo (aqui, simulado com `npm run app-version -- --platform android --min 2.14.0`) e a métrica
de uso está zerada acima da mínima. Com isso, o app 2.13 recebe **426** antes de chegar à validação (o usuário vê
"atualize", não um erro de formulário), e só um cliente **sem** versão que ainda mande `dueDate` recebe **400** pelo
`forbidNonWhitelisted`.

O que eu esperava do CI, e o que aconteceu: a remoção deveria falhar o check do contrato e pedir a label. O oasdiff
classificou as três remoções como **informativas**, por dois motivos que valem a pergunta de entrevista:

- **Entrada:** `request-property-removed-with-deprecation`. O campo foi **depreciado antes**, e remover algo depreciado é
  o desfecho anunciado do ciclo de vida, não uma surpresa.
- **Saída:** `response-optional-property-removed`. O `dueDate` estava documentado como **opcional** nas respostas, embora
  viesse sempre. Pelo contrato, um cliente correto já tolerava a ausência; a ferramenta não tinha como saber que o app
  dependia dele. **A documentação prometia menos do que a API entregava.** A correção (campos sempre presentes como
  `required`, ainda que `nullable`) é compatível e entrou na 14.4c (abaixo).

A conclusão está no ADR-0008: **o CI pega a quebra acidental; a quebra planejada é decidida pelos critérios.**

O que **não** sai: o *upcaster* (os eventos v1 continuam gravados, e para sempre), o `dueDate` do contrato público do
tópico (outro ciclo de vida, ADR-0004) e o `DeprecationNotifier` (o mecanismo padrão para o próximo campo, sem uso
agora). E um efeito colateral bom: o E2E de tarefas ainda criava com `dueDate` e quebrou com 400. Foi o primeiro
"cliente que não migrou" (problema 12).

**O fim (14.4c): a coluna sai, e o contrato passa a prometer o que entrega.** O `DROP COLUMN due_date` foi num PR
(e deploy) depois da 14.4b, quando nenhuma versão no ar usava mais a coluna. Duas defesas na migração:

- **`SET LOCAL lock_timeout = '5s'`.** O `DROP COLUMN` no Postgres é rápido (só marca a coluna como removida, sem
  reescrever a tabela), mas pede um lock `ACCESS EXCLUSIVE`. Se uma consulta longa estiver usando a tabela, o `ALTER`
  espera, e **toda requisição seguinte entra na fila atrás dele**: uma migração "instantânea" trava a API. Com o
  timeout, ela desiste em 5 s (e pode rodar de novo). `LOCAL` limita a configuração à transação da migração.
- **Checagem anti-perda:** um bloco `DO` conta as linhas com `due_date` preenchida e `due_at` vazia (um backfill que
  deixou algo para trás) e **aborta** a migração se houver alguma. O teste roda o SQL real da migração num schema
  descartável, que imita a tabela de antes: com uma linha sem cópia, aborta e a coluna fica; com tudo copiado, a
  coluna sai.

E a correção do achado da 14.4b: a auditoria de **todos** os DTOs de resposta comparou cada campo opcional com o que o
código devolve. `ProjectResponseDto.description` e `TaskReadDto.assigneeId`/`completedAt` vêm sempre (como `null`) e
viraram `required` + `nullable`; os do histórico e do snapshot dos comandos são omitidos quando vazios e ficaram
opcionais. A prova, com o oasdiff, simulando a remoção do `assigneeId` da listagem: contra o contrato antigo,
`response-optional-property-removed` (**informativo**); contra o novo, `response-required-property-removed` (**erro**).

**O contrato público do tópico também faz expand.** O `TaskCreated` de integração ganhou `due` como campo **opcional**
(compatível: os consumers são leitores tolerantes e ignoram o que não conhecem) e mantém o `dueDate`, derivado do
`due`. Tirar o `dueDate` do tópico é mudança incompatível de um contrato que outros serviços leem (`eventVersion` 2),
e fica fora do escopo.

### Idempotency-Key (14.5): repetir uma requisição sem duplicar o efeito

**O problema.** O app manda `POST /tasks`, o servidor cria a tarefa, e a resposta se perde (túnel, troca de Wi-Fi para
4G, timeout). O app não sabe se deu certo e repete: duas tarefas. Numa fintech, duas transferências. Só o **cliente**
sabe se duas requisições iguais são a mesma intenção (duas transferências de R$ 100 para a mesma pessoa podem ser
legítimas), então é ele quem gera uma chave por intenção e a manda em `Idempotency-Key`, a MESMA em toda nova
tentativa.

| Situação | Resposta |
|---|---|
| Chave nova | Cria; guarda a resposta |
| Mesma chave, mesmo pedido | **A mesma resposta** (201, o mesmo `taskId`), sem criar nada, com `Idempotent-Replayed: true` |
| Mesma chave, pedido diferente | **422** `IDEMPOTENCY_KEY_REUSED` (um bug no app, que reaproveitou a chave) |
| Sem o header | Como antes (é opcional: exigi-lo quebraria os apps instalados) |
| Header inválido | **400**: o cliente pediu uma garantia, e ignorá-la em silêncio poderia criar o duplicado |

**A decisão central: a chave NA MESMA transação da tarefa** ([ADR-0009](../adr/0009-idempotencia-de-requisicoes-na-transacao-do-efeito.md)).
O desenho ingênuo é "reservar a chave → criar → marcar como concluída": duas escritas em dois momentos, o dual-write do
Módulo 13 outra vez. Um crash entre criar e marcar deixa a chave presa; com prazo na reserva, a tentativa seguinte cria
uma SEGUNDA tarefa. Aqui, a linha da chave (com a resposta, já conhecida: o `taskId` é gerado antes) é mais um INSERT
da transação do `TaskCreated`, junto com o evento e a outbox, pelo gancho genérico `alsoWrite` do Event Store. Ou a
tarefa existe e a chave está registrada, ou nenhuma das duas. É o `processed_events` (13.4) do lado HTTP.

**A corrida.** Duas tentativas simultâneas passam pela busca sem achar nada e tentam gravar. A chave primária
`(user_id, key)` deixa uma só: o INSERT da segunda espera o COMMIT da primeira e falha, a transação dela é desfeita
inteira (a tarefa dela não existe), e o handler busca de novo e devolve a resposta da vencedora. Provado com 10
requisições simultâneas: uma tarefa, e o mesmo `taskId` nas 10 respostas. Para separar essa colisão de um conflito de
versão, o handler consulta a tabela de novo em vez de interpretar o nome da constraint no erro do Prisma (frágil entre
versões); um conflito de versão num agregado NOVO exigiria dois UUIDs aleatórios iguais.

**Os detalhes que fazem diferença:**
- **Por usuário** (a PK é `(user_id, key)`): ninguém recebe a resposta guardada de outro adivinhando a chave (OWASP
  A01). E a autorização vem ANTES da busca: projeto alheio dá 404 mesmo com uma chave já usada.
- **"O mesmo pedido"** = SHA-256 de método + rota (com o `projectId`) + corpo validado, numa serialização estável (a
  mesma do snapshot do contrato da 14.3, agora em `src/common/json/`): a ordem das chaves do JSON não muda o hash.
- **Só o sucesso é guardado.** Uma criação que falhou (404, 400) não teve efeito; a nova tentativa executa de novo.
- **Validade de 24 h** (`IDEMPOTENCY_KEY_TTL_HOURS`), como no Stripe. Vencida conta como nova: a busca a ignora e a
  gravação a substitui na mesma transação. Um job apaga as vencidas a cada hora, em lotes (o padrão do 13.6c).
- **Métrica** `taskflow_idempotency_requests_total{outcome}`: `created`, `replayed` (alto = rede ruim ou app repetindo
  demais) e `reused` (422: bug de cliente).
- **O `CommandBus` devolve `any`.** O handler passou a devolver `{ taskId, replayed }`, e o controller, que esperava o
  `taskId` como texto, compilaria e responderia `{ "taskId": { "taskId": ..., "replayed": ... } }`. O tipo explícito
  no controller (`const result: CreateTaskResult`) e o E2E fecham essa porta (problema 14).

O limite: funciona porque o efeito é uma transação no MESMO banco. Um efeito externo (cobrar num gateway) exigiria a
reserva com prazo e a chave repassada ao sistema externo, que também precisa ser idempotente.

### Feature flags (14.6): liberar aos poucos e desligar em segundos

**Por que, num sistema com apps.** Uma tela nova com bug só se corrige publicando outra versão na loja: horas ou dias.
Com a tela atrás de uma flag, ela é liberada aos poucos (time interno → 10% → 50% → todos) e **desligada em segundos**,
sem deploy e sem loja. A decisão de construir (e não usar LaunchDarkly, Unleash ou AppConfig) está no
[ADR-0010](../adr/0010-feature-flags-proprias.md), com o que se perde (interface, experimentos, segmentação rica) e
quando revisitar.

**A arquitetura:** a porta `FeatureFlags` (`isEnabled`, `evaluateAll`) é tudo o que o resto do sistema conhece; o
adapter `PostgresFeatureFlags` lê as regras (são poucas) com cache e avalia localmente, sem chamada de rede por
requisição. Trocar por um serviço gerenciado seria outro adapter.

**A avaliação: uma função pura, e a ORDEM é a decisão** ([`feature-flag.rules.ts`](../../src/modules/feature-flags/feature-flag.rules.ts)):

| # | Regra | Por que nesta posição |
|---|---|---|
| 1 | Flag inexistente → desligada | Código que pergunta por uma flag que ninguém criou não liga nada por engano |
| 2 | Kill switch → desligada para TODOS | Antes de tudo, inclusive da lista de usuários: em incidente, desligar é absoluto. Mutação (a lista antes do kill switch): o teste falha |
| 3 | Restrições: plataforma fora da lista, ou app abaixo da versão mínima → desligada | A tela só existe a partir de uma versão; cliente desconhecido (sem os headers da 14.1) não passa por uma restrição |
| 4 | Lista de usuários → ligada | Time interno e beta, mesmo com 0% |
| 5 | Porcentagem: `bucket < rollout` → ligada | O rollout gradual |

**O bucket: `sha256("flagKey:userId")`, 4 bytes, `mod 100`.** As três propriedades, todas com teste sobre 10 mil
usuários simulados (e 10% liga ~10% deles):
- **determinístico:** o mesmo usuário cai sempre no mesmo grupo, em qualquer réplica. Sem isso, a tela apareceria e
  sumiria aleatoriamente;
- **monotônico:** `bucket < rollout` com o rollout subindo de 10 para 20 mantém os primeiros 10%. Ninguém perde a
  funcionalidade que já tinha;
- **o nome da flag no hash:** cada flag sorteia os SEUS usuários. Sem ele, os mesmos 10% seriam a cobaia de todo rollout
  (mutação: o teste de independência falha).

**Fail-closed, o contrário da versão mínima.** O cache é de 5 s (menor que os 30 s da 14.2: o kill switch precisa
valer rápido), com leitura única e o último valor conhecido. Mas, se a configuração NUNCA foi lida, toda flag fica
desligada. Na versão mínima, o desastre seria BLOQUEAR todo mundo, e lá a falha deixa passar; aqui, o desastre seria
LIGAR algo para todos, e a falha desliga. **O lado seguro depende do que a falha causa.** E o fail-closed nem precisou
de código próprio: sem regras, toda flag "não existe" (regra 1).

**`GET /me/features`: só o resultado.** O app chama ao abrir e recebe `{ "flags": { "tela-nova": true } }`, nunca a
porcentagem, a lista de usuários ou as restrições. Ninguém descobre os testadores lendo o tráfego, e a regra muda sem
versão nova do app. `Cache-Control: private, no-cache`: o resultado é do usuário e é revalidado a cada abertura.

**O comando `npm run feature-flag`** segue o `app-version`: valida com mensagem legível (e as mesmas regras viram
CHECK no banco), grava numa transação sob advisory lock, audita antes/depois em `feature_flag_changes`, tem
`--dry-run`. Flag nova nasce desligada e com 0%. E o kill switch desliga **sem apagar a regra**: religar volta
exatamente ao estado de antes do incidente.

**Métrica:** `taskflow_feature_flag_evaluations_total{flag, enabled, reason}`. O nome da flag é seguro como label (são
poucas e criadas por nós; uma chave inventada pelo código não vira série), e a `reason` responde "por que o usuário X
não vê a tela?". O `userId` nunca entra.

### A primeira funcionalidade atrás de uma flag (14.7): medir antes de avançar

**A funcionalidade.** Com a flag `task-list-with-stats` ligada, a primeira página de `GET /projects/:id/tasks` traz
também `stats`, os números do projeto (do consumer `reports`, 13.6a): o app deixa de fazer duas chamadas. A flag não é
cerimônia: a mudança tem dois riscos reais, uma consulta a mais na rota mais chamada da API (latência) e números que
dependem de um processo assíncrono (por isso o `asOf` visível).

**Quem decide e quem executa.** O controller pergunta à porta `FeatureFlags` (com o usuário e o app) e passa
`includeStats` para a consulta; o handler da listagem não sabe que existe flag. E a leitura dos números
(`ReportsService.statsOf`) não repete a checagem de dono que a listagem já fez: seria uma consulta a mais justamente
na rota medida. `stats` só na primeira página: o app pede o resumo uma vez, e repeti-lo na rolagem seria custo à toa.
No contrato, `stats` é **opcional de verdade** (só com a flag e só na primeira página): a lição da 14.4.

**Medir por variante: o "experimento feito à mão" do ADR-0010.** `taskflow_task_list_duration{variant, page}`
(histograma com buckets em segundos, a lição da 13.6d) e `taskflow_task_list_requests_total{variant, page, outcome}`.
Duas escolhas que tornam a comparação honesta:
- **a mesma janela, grupos sorteados pelo bucket:** a variante e o controle convivem no mesmo período, e o bucket não
  tem relação com o perfil do usuário. Comparar "antes × depois" misturaria a mudança com tudo o mais que mudou;
- **só a primeira página, e só erro do servidor:** as páginas seguintes são iguais nos dois grupos e diluiriam a
  diferença; um 404 de projeto alheio é erro do CLIENTE e só faria ruído (`outcome="client_error"`).

**O critério escrito antes de ligar** ([ADR-0011](../adr/0011-criterio-de-avanco-do-rollout.md)). Avançar (10% → 50% →
100%) numa janela de 24 h com pelo menos 1.000 requisições na variante, sem regressão de latência, sem erro acima do
controle, com o consumer `reports` em dia e sem alerta crítico. Reverter com o kill switch se latência ou erro
violarem por 15 min. Remover a flag depois de 2 semanas em 100%: **flag é dívida técnica**.

**Regressão = p95 maior que 1,2× o do controle E mais de 50 ms acima.** Refinado durante a implementação: o desenho
dizia "≤ 1,2× e ≤ +50 ms", condições que precisariam valer as duas, e isso alertaria por ruído em latência baixa (5 ms
contra 7 ms é 1,4×, e 2 ms não importam). O relativo pega a piora proporcional; o absoluto é o piso contra o ruído.

**O critério virou alerta** (`TaskListStatsSlower`, `TaskListStatsErrors`), com piso de tráfego (0,1 req/s na
variante: não decidir com 3 requisições) e testado com `promtool` em quatro casos: regressão real dispara; ruído em
latência baixa, tráfego baixo e o período do `for` não. E um detalhe de PromQL que o teste pegou: sem nenhum erro no
controle, a série de erro DELE não existe, a subtração sai vazia e o alerta morreria calado no caso mais comum; o
`or vector(0)` resolve (mutação: sem ele, o teste falha). No Grafana, a linha "Rollout" do dashboard da API mostra p95
e taxa de erro lado a lado.

## 📋 Como reproduzir

### Identificação do cliente (14.1)

```bash
npm run infra:up:obs     # Postgres, Jaeger, Prometheus e Grafana
npm run dev              # ou: npm run build && node dist/main
```

```bash
curl -i -H 'X-Platform: ios' -H 'X-App-Version: 2.14.7' -H 'X-Correlation-Id: demo-14' localhost:3000/
curl -s -o /dev/null -H 'X-Platform: Android' -H 'X-App-Version: 2.13.1' localhost:3000/auth/me   # 401, e registrado
curl -s -o /dev/null -H 'X-App-Version: 999.0.0' localhost:3000/                                   # métrica: other
curl -s -o /dev/null localhost:3000/                                                               # unknown / none

curl -s localhost:9464/metrics | grep taskflow_app_requests_total
```

- **Log de acesso:** a linha de acesso traz `"client":{"platform":"ios","appVersion":"2.14.7"}`, uma vez só. As
  outras linhas da requisição não repetem o cliente: o `correlationId` as liga à linha de acesso.
- **Jaeger** (`http://localhost:16686`, serviço `taskflow`): *Tags* `correlation.id=demo-14`; o span `GET /` tem
  `taskflow.client.platform` e `taskflow.client.app_version`.
- **Grafana** (`http://localhost:3001`): dashboard da API → linha **Clientes**, requisições por plataforma e por versão.
- **Swagger** (`/docs`): `X-Platform` e `X-App-Version` aparecem em todas as rotas, como parâmetros globais.

### Versão mínima (14.2)

```bash
npm run app-version -- --show
npm run app-version -- --platform android --min 2.10.0 --recommended 2.12.0 --dry-run
npm run app-version -- --platform android --min 2.10.0 --recommended 2.12.0 --by "seu-nome (motivo)"

curl -s -H 'X-Platform: android' -H 'X-App-Version: 2.9.0' localhost:3000/auth/me        # 426 (e não 401)
curl -s -o /dev/null -D - -H 'X-Platform: android' -H 'X-App-Version: 2.11.0' localhost:3000/ | grep -i x-app
curl -s localhost:9464/metrics | grep taskflow_app_update_required_total

npm run app-version -- --platform android --min none --recommended none                 # remove a política
```

- A mudança vale na API em até 30 s (o TTL do cache), sem reiniciar.
- Mínima acima da recomendada é recusada com a explicação; versão fora do formato também.
- Auditoria: `SELECT * FROM app_version_policy_changes ORDER BY id DESC;`

### Contrato da API (14.3)

```bash
npm run openapi:check                 # build + confere docs/api/openapi.json (o CI roda o mesmo)
npm run openapi:generate              # depois de mudar a API: regera o snapshot (revise o diff e commite)
npm run openapi:diff                  # mudanças incompatíveis contra a origin/main (Docker)
npm run openapi:diff -- --base x.json # contra outro arquivo (experimentos)
```

Para ver o `check` falhar: mude o `maxLength` de um DTO e rode `npm run openapi:check`; ele aponta a linha. Para ver
uma mudança incompatível: gere uma base com `jq` (ex.: `jq '.components.schemas.CreateTaskDto.required -= ["title"]'
docs/api/openapi.json > /tmp/base.json`) e rode `npm run openapi:diff -- --base /tmp/base.json`.

### Prazo (14.4): o estado depois do expand/contract

Os comandos de cada fase (o `dueDate` aceito com `Deprecation`/`Sunset` no expand, o diff com as remoções
informativas no contract) só valiam **durante** aquelas fases; o que cada uma mostrou está em "Resultados". Hoje:

```bash
TOKEN=...; P=<projectId>
# O formato atual: due { at com fuso, timezone IANA } → 201; a API devolve o at em UTC + o fuso
curl -s -X POST localhost:3000/projects/$P/tasks -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Com prazo","due":{"at":"2026-12-31T23:59:59-03:00","timezone":"America/Sao_Paulo"}}'
# O formato antigo saiu da API (14.4b): 400 "property dueDate should not exist"
curl -s -X POST localhost:3000/projects/$P/tasks -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"x","dueDate":"2026-12-31T23:59:59Z"}'
# Um app ABAIXO da versão mínima recebe 426 antes da validação (com uma política ativa, ver 14.2)
psql ... -c '\d tasks_read'                                  # só due_at e due_timezone (14.4c)
npm run test:integration -- task-event-upcaster drop-due-date  # v1 lido como v2; a migração do DROP abortando e passando
```

- O `TaskCreated` v1 continua gravado no banco como v1 (`SELECT payload, metadata FROM events WHERE
  event_type='TaskCreated'`), e o histórico (`GET .../history`) o devolve já como v2: o *upcaster* é para sempre.
- Para declarar o próximo campo depreciado, veja a 14.8.

### Idempotency-Key (14.5)

```bash
K=$(uuidgen)
for i in 1 2; do
  curl -s -D - -X POST localhost:3000/projects/$P/tasks -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -H "Idempotency-Key: $K" -d '{"title":"Transferência"}' \
    | grep -iE '^(HTTP|idempotent)|taskId'
done      # 2x 201 com o MESMO taskId; a 2ª com Idempotent-Replayed: true
curl -s -X POST localhost:3000/projects/$P/tasks -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $K" -d '{"title":"Outra coisa"}'   # 422
curl -s localhost:9464/metrics | grep taskflow_idempotency_requests_total
```

### Feature flags (14.6)

```bash
npm run feature-flag -- --key tela-nova --description "Tela nova"                       # nasce desligada
npm run feature-flag -- --key tela-nova --enable --allow <seu-userId>                     # só você
npm run feature-flag -- --key tela-nova --rollout 10 --platforms ios,android --min-app-version 2.15.0 --dry-run
curl -s localhost:3000/me/features -H "Authorization: Bearer $TOKEN" -H 'X-Platform: ios' -H 'X-App-Version: 2.15.0'
npm run feature-flag -- --key tela-nova --kill --by "seu-nome (motivo)"                    # em até 5 s, para todos
npm run feature-flag -- --show
```

### Rollout da `task-list-with-stats` (14.7)

```bash
npm run feature-flag -- --key task-list-with-stats --description "Números do projeto na listagem"
npm run feature-flag -- --key task-list-with-stats --enable --rollout 50
# gere tráfego de vários usuários (DISABLE_THROTTLE=true para cadastrar rápido) e compare as variantes:
curl -s localhost:9464/metrics | grep taskflow_task_list_requests_total
# Prometheus: histogram_quantile(0.95, sum by (le, variant) (rate(taskflow_task_list_duration_bucket{page="first"}[5m])))
npm run feature-flag -- --key task-list-with-stats --kill      # with-stats para de crescer; o tráfego vai para o control
```

Grafana → dashboard da API → linha **Rollout**; alertas em `http://localhost:9090/alerts` (`TaskListStats*`).

### A política (14.8)

```bash
npm run test:unit -- --testPathPatterns deprecation-policy   # 89 dias de aviso falha; 90 e o dueDate (97) passam
jq -r .info.description docs/api/openapi.json       # o parágrafo "Compatibilidade (ADR-0012)" que o app lê no Swagger
```

O próximo campo depreciado entra em `DEPRECATED_FIELDS` ([`deprecation.ts`](../../src/common/deprecation/deprecation.ts))
com `Sunset` pelo menos 90 dias depois do `Deprecation`; com menos, o teste quebra o build. O sinal ao cliente é o do
`DeprecationNotifier` (os headers `Deprecation`, `Sunset` e `Link` da 14.4a).

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | **(14.1)** Os atributos do cliente apareciam no span `middleware - clientInfoMiddleware`, e não no `GET /`. O `correlation.id` (Módulo 01) também | Dentro de um middleware Express, o span ATIVO é o do próprio middleware, aberto pelo `instrumentation-express` | `currentRequestSpan()`: o span do request vem do `rpcMetadata` do contexto, com o ativo como fallback. Teste que reproduz o Express; com o helper devolvendo o ativo, ele falha. Registrado também como problema 23 do Módulo 01 |
| 2 | **(14.1)** O teste do dashboard recusava a consulta nova, mesmo com a métrica na lista | O extrator de nomes de métrica do teste só reconhecia alguns prefixos (`http_`, `kafka_`…): a consulta parecia não usar métrica nenhuma | Prefixo `taskflow_` no extrator. O teste fez o que devia: consulta sem métrica reconhecida é tratada como "No data" em potencial |
| 3 | **(14.2)** O 426 funcionava, mas não aparecia no log de acesso: um app sendo bloqueado sem rastro | O bloqueio era `app.use()`, e o log de acesso do `pino-http` é middleware de MÓDULO do Nest, montado depois: a resposta saía antes de o logger existir | Middleware de módulo (`VersionGateMiddleware`, registrado pelo `VersionPolicyModule` depois do `LoggerModule`). Continua antes dos guards. Conferido ao vivo: o 426 sai como `warn`, com o cliente e o `correlationId` |
| 4 | **(14.2)** Um teste E2E do Módulo 01 quebrou com a mudança | Ele comparava `Access-Control-Expose-Headers` por **igualdade** com `X-Correlation-Id`, e a lista passou a ter três headers | Checagem de presença na lista. Uma asserção mais rígida que o contrato quebra com toda mudança legítima |
| 5 | **(14.3)** O snapshot não podia sair de um teste do Jest | O `ts-jest` não roda o plugin do Swagger, que só existe no `nest build`: o documento sairia sem as propriedades que o plugin infere (o `LoginDto` vazio) | Script que importa o `dist/` (`scripts/openapi/snapshot.ts`), e o `openapi:check` faz o build antes. Experimento: documento completo, sem banco, em ~100 ms |
| 6 | **(14.3)** O `actionlint` imprimia a ajuda em vez de analisar | `-color=never` não é uma flag válida dele (o certo é `-no-color`) | Os dois workflows passam no `actionlint`, que inclui o `shellcheck` dos passos `run` |
| 7 | **(14.3)** Com uma base vazia (um `jq` que falhou num experimento), o oasdiff disse "nenhuma mudança incompatível" | Comparar contra nada não encontra nada para quebrar: um falso OK que, no CI, aprovaria qualquer mudança | Os dois (script e workflow) recusam base ou snapshot que não seja JSON com o campo `openapi`. No mesmo passo, o script deixou de usar `process.exit` dentro do `try` (pulava o `finally` e a pasta temporária ficava) |
| 8 | **(14.4a)** A listagem devolvia a linha do Prisma crua: as colunas novas do expand (`due_at`, `due_timezone`) vazariam como campos soltos no contrato | O handler retornava `findMany()` direto, sem mapeamento. Achado lendo o código antes de mudar o schema | `toTaskListItem()`, campo a campo (como o contrato de integração já fazia); teste de que nenhuma coluna interna aparece na resposta |
| 9 | **(14.4a)** O backfill rodaria antes do código novo: linhas criadas pela versão anterior da API no meio do deploy ficariam sem `due_at` | Migrações rodam antes do deploy, e a versão anterior ainda escreve só na coluna velha | Backfill idempotente (o contract o repete) e leitura `due_at ?? due_date` durante a transição; testes da idempotência com o SQL da própria migração |
| 10 | **(14.4a)** Os testes unitários do repositório quebraram com o upcaster | As linhas simuladas não tinham a coluna `metadata`, que o upcaster passou a ler (no banco ela é `NOT NULL DEFAULT '{}'`) | Linhas simuladas realistas (`metadata: {}`, um evento legado) |
| 11 | **(14.4b)** A remoção do `dueDate` não falhou o check do contrato, como eu tinha previsto (e escrito na 14.4a) | O oasdiff aceita remover campo de entrada **depreciado antes** (`request-property-removed-with-deprecation`) e campo de resposta documentado como **opcional** (`response-optional-property-removed`). O `dueDate` das respostas vinha sempre, mas era `@ApiPropertyOptional` | Registrado no ADR-0008: o CI pega a quebra não anunciada; a planejada é decidida pelos critérios. Campos sempre presentes das respostas viram `required` na 14.4c |
| 12 | **(14.4b)** O E2E de tarefas quebrou com 400 | Ele ainda criava tarefas com `dueDate`: era, na prática, um cliente que não migrou | Atualizado para `due`. É o efeito exato do contract em quem ficou para trás, e por isso a versão mínima vem antes |
| 13 | **(14.4c)** O teste da migração do `DROP` não conseguia rodar o arquivo SQL pelo Prisma | O arquivo tem vários comandos e um bloco `DO`; o Prisma executa um comando por vez (protocolo estendido) | O teste usa o driver `pg` (protocolo simples, aceita vários comandos), agora declarado como `devDependency` em vez de usado como dependência indireta do adapter do Prisma |
| 14 | **(14.5)** O `tsc` não acusou que o controller continuava tratando o retorno do handler como texto | O `CommandBus.execute` devolve `any`: a mudança de `string` para `{ taskId, replayed }` compilaria e a resposta viraria `{ "taskId": { ... } }` | Tipo explícito no controller (`const result: CreateTaskResult`) e o E2E conferindo o corpo. Lição: onde a API do framework devolve `any`, o tipo não protege |
| 15 | **(14.7)** A primeira demonstração do rollout deu 3 usuários com `stats` e 17 sem, em 50% | 9 cadastros foram recusados (nome com menos de 3 caracteres) e o script contava a listagem que falhou com 401 como "controle": os números não fechavam (165 listagens contadas para 20 × 15) | Dados válidos e o script contando falhas à parte. Lição: conferir se o experimento criou a condição que pretendia (a mesma do problema 18 do Módulo 13) |
| 16 | **(14.7)** O alerta de erro por variante morreria calado no caso mais comum | Sem nenhum erro no controle, a série de erro dele não existe, e a subtração `variante - controle` sai vazia | `or vector(0)` no numerador; teste do `promtool` com o controle sem erro, e a mutação sem ele falhando |
| 17 | **(depois do módulo)** A linha de acesso saía com `"client"` **duas vezes**; achado lendo o log do container na Etapa E.1 (Módulo 03) | O pino-http chama o `customProps` no início e no fim da requisição e evita a duplicata comparando texto, depois de apagar TODAS as chaves `{}` do JSON: com um objeto aninhado a comparação nunca casa. Nenhum teste viu: o unitário conferia só a função (certa), e o `JSON.parse` aceita chave duplicada em silêncio | O `client` entra pelos ganchos que montam a linha (`customSuccessObject`/`customErrorObject`). Teste com o pino-http real conferindo a linha **crua** (1 ocorrência em 201, 426 e 500); mutação com o `customProps` antigo: 2 ocorrências, vermelho. De quebra: a doc dizia "em cada linha da requisição", mas as linhas da aplicação nunca tiveram o `client` (só o `correlationId`); a doc foi corrigida |

---

## 📊 Resultados obtidos

**14.1 — identificação do cliente** (API em `node dist/main`)

| Experimento | Resultado |
|---|---|
| 7 requisições: 3 `ios 2.14.7`, 1 `Android 2.13.1` (401), 1 `web 5.0.0`, 1 só `999.0.0`, 1 sem headers, + 1 probe | `/metrics`: `ios/2.14` = 3, `android/2.13` = 1, `web/5.0` = 1, `unknown/other` = 1, `unknown/none` = 1; o probe não contou |
| A mesma consulta no Prometheus (a do painel) | As 5 séries, com os mesmos valores |
| Log de acesso | `client` em todas as linhas de acesso, com a versão completa (`999.0.0` inclusive); o 401 também registrado. **Duplicado** em cada linha até a correção do problema 17 |
| Jaeger, antes da correção | Atributos no span do middleware; `GET /` sem eles |
| Jaeger, depois | `GET /` com `correlation.id`, `taskflow.client.platform` e `taskflow.client.app_version`; nenhum outro span com eles |
| **Mutação:** contador criado no import | 2 testes falham (nada é contado) |
| **Mutação:** `currentRequestSpan` devolvendo o span ativo | O teste que reproduz o Express falha |
| Testes novos | 28 unitários (parser e comparação, resolução, label, middleware com OTel em memória, decorator, log) e 5 E2E (headers válidos, inválidos e ausentes; 401 do JWT; preflight do CORS) |
| Suítes | 313 unitários · 54 E2E · integração e streaming sem mudança |

**14.2 — versão mínima** (API em `node dist/main`, cache padrão de 30 s)

| Experimento | Resultado |
|---|---|
| `npm run app-version`: `--show`, `--dry-run`, mudança real, mínima acima da recomendada, sem argumentos | Sem política → `[dry-run]` antes → depois sem gravar → gravado com quem e quando → recusado com a explicação → mensagem de uso e código de saída 1 |
| Android 2.9.0 com mínima 2.10.0, em `/auth/me` sem token | **426** com o corpo completo (e não 401); no log de acesso: `warn`, `client` e `correlationId` |
| Android 2.11.0 com recomendada 2.12.0 | 200, `X-App-Update: recommended`, `X-App-Recommended-Version: 2.12.0`, ambos em `Access-Control-Expose-Headers` |
| Mínima baixada pelo comando com a API rodando | A 2.9.0 passou a ser aceita depois de **30 s**, sem reinício |
| Banco: `CHECK` da mínima acima da recomendada | `1.10.0` / `1.9.0` recusado pelo banco (comparação numérica no SQL) |
| Drift do Prisma depois da migração com as `CHECK` | `migrate dev --create-only` gerou uma migração **vazia** |
| **Mutação:** sem a leitura única | 20 requisições simultâneas → 20 consultas; o teste falha |
| **Mutação:** sem o "último valor conhecido" | O bloqueio vigente some na primeira falha do banco; o teste falha |
| Testes novos | 14 unitários (decisão, cache, leitura única, fail-open, middleware), 6 de integração (comando, auditoria, `CHECK`, a API lendo o que o comando gravou) e 6 E2E (426 em rota pública e protegida, aviso + CORS, quem passa, mudança sem reinício) |
| Suítes | 327 unitários · 80 integração · 60 E2E |

**14.3 — contrato da API**

| Experimento | Resultado |
|---|---|
| `openapi:generate` | `docs/api/openapi.json`: OpenAPI 3.0, 15 caminhos, 21 schemas, 2.580 linhas; nada do ambiente (URL de banco, segredo) no arquivo |
| Gerar duas vezes, em processos diferentes | Mesmo hash |
| `maxLength` de 100 para 80 num DTO, sem atualizar o snapshot | `openapi:check` falha na linha 65 (`- 100` / `+ 80`), com a instrução; restaurado, passa |
| oasdiff: base igual | Nenhuma mudança incompatível |
| oasdiff: campo obrigatório removido da resposta | `removed the required property ... from the response`, falha |
| oasdiff: campo acrescentado na resposta | Nenhuma mudança incompatível |
| oasdiff: `title` de opcional para obrigatório na requisição | `request-property-became-required`, falha |
| oasdiff: `maxLength` da requisição diminuído | `request-property-max-length-decreased`, falha |
| oasdiff: valor novo (`DONE`) num `enum` da resposta | `response-property-enum-value-added`, falha |
| oasdiff: rota removida | `api-path-removed-without-deprecation`, falha |
| oasdiff: campo removido da requisição | `request-property-removed` como **aviso**, sem falha |
| oasdiff: campo da resposta de opcional para obrigatório | Nenhuma mudança incompatível |
| oasdiff: base vazia ou sem `openapi` | Antes: "nenhuma mudança incompatível" (falso OK). Depois: recusada nos dois (script e workflow) |
| oasdiff: a `main` sem o arquivo (este PR) | Aviso de que não há contrato anterior, sem falha |
| `actionlint` nos dois workflows | Sem apontamentos |
| Testes novos | 5 unitários (ordem estável das chaves, arrays preservados, diferença apontada por linha) |

**14.4a — expand do prazo**

| Experimento | Resultado |
|---|---|
| oasdiff contra a `main` | **0 incompatíveis**; `changelog`: `dueDate` depreciado na entrada, na listagem e no histórico; `due` opcional na entrada e novo nas duas respostas |
| App antigo (`dueDate`) e app novo (`due`), E2E | Antigo: 201 com `Deprecation: @<epoch>`, `Sunset: Mon, 01 Mar 2027 00:00:00 GMT` e `Link`, expostos no CORS; lê `dueDate` e `due` com `timezone: null`. Novo: sem headers; `at` em UTC + o fuso, na listagem e no histórico; o `dueDate` derivado continua lá |
| 400 | Os dois formatos juntos; `at` sem fuso; offset no lugar do fuso; fuso inexistente |
| `TaskCreated` v1 gravado no Postgres (com e sem envelope) | Lido pelo repositório como v2 (`timezone: null`); a linha no banco continua v1 |
| Backfill com o SQL da migração | Copia só as linhas antigas, sem fuso, sem tocar nas novas; a 2ª execução altera **0** linhas |
| Migração expand | Só `ADD COLUMN` aceitando NULL; aplicada sem drift |
| **Mutação:** `toDomainEvent` sem o upcaster | 2 testes de integração falham (o evento v1 perde o prazo) |
| Testes novos | 13 unitários (upcaster, validação, mapeamento da listagem, headers) e 4 de integração (upcaster no banco real, com e sem envelope; backfill e idempotência), 6 E2E; e 9 existentes adaptados ao formato novo |
| Suítes | 347 unitários · 84 integração · 66 E2E · 13 streaming |

**14.4b — contract do prazo, passo 1**

| Experimento | Resultado |
|---|---|
| oasdiff contra a `main` | **0 incompatíveis**; `changelog`: 3 informativas (`request-property-removed-with-deprecation` na entrada; `response-optional-property-removed` na listagem e no histórico) |
| Mínima do Android em 2.14.0; app 2.13 manda `dueDate` | 426 `APP_UPDATE_REQUIRED`, antes da validação |
| Cliente sem versão manda `dueDate` | 400 `property dueDate should not exist` |
| App atual com `due` | 201; listagem e histórico só com `due`, sem `dueDate`; sem headers de depreciação |
| Backfill final + `migrate dev --create-only` | Aplicado; migração de checagem vazia (a coluna continua no schema até a 14.4c, sem drift) |
| Testes | Os do expand reescritos para o estado depois do contract (unitário `due.spec.ts`, E2E `due.e2e-spec.ts`); o E2E de tarefas e o teste de integração da projeção migrados para `due` |
| Suítes | 346 unitários · 84 integração · 66 E2E · 13 streaming |

**14.4c — fim do expand/contract**

| Experimento | Resultado |
|---|---|
| Migração do `DROP` aplicada | `tasks_read` só com `due_at` e `due_timezone` |
| SQL da migração com uma linha sem cópia (schema descartável) | Aborta com "1 linha(s) de tasks_read com due_date sem due_at"; a coluna continua |
| SQL da migração com tudo copiado | A coluna sai |
| Auditoria das respostas | 3 campos passaram a `required` + `nullable`; 5 continuam opcionais (omitidos quando vazios) |
| oasdiff contra a `main` | 0 incompatíveis (opcional → obrigatório na resposta é compatível) |
| Remover `assigneeId` da listagem, contra o contrato antigo × o novo | `response-optional-property-removed` (info) × `response-required-property-removed` (**erro**) |
| Testes | 2 de integração novos (a migração); os do backfill da 14.4a saíram (a coluna não existe); o do upcaster renomeado |
| Suítes | 345 unitários · 84 integração · 66 E2E · 13 streaming |

**14.5 — Idempotency-Key**

| Experimento | Resultado |
|---|---|
| 10 requisições simultâneas com a mesma chave (Postgres real) | 1 tarefa, 1 evento, 1 mensagem na outbox, 1 chave; as 10 respostas com o mesmo `taskId` (1 criada, 9 repetidas). 3 execuções estáveis |
| **Mutação:** a chave gravada DEPOIS, numa transação separada (o desenho ingênuo) | 2 testes falham: o das requisições simultâneas e o do "tudo ou nada" |
| A gravação da chave falhando (CHECK de tamanho) | A transação inteira desfeita: nem a tarefa existe |
| Mesma chave de dois usuários / chave vencida | Duas tarefas / conta como nova (a vencida é substituída) |
| HTTP: nova tentativa · outro pedido · chave inválida · sem header · criação que falhou | Mesmo `taskId` + `Idempotent-Replayed: true` · 422 · 400 · duas tarefas · nada guardado |
| oasdiff contra a `main` | 0 incompatíveis: parâmetro opcional novo, header de resposta novo, 422 novo (todos informativos) |
| Testes novos | 18 unitários (header, hash, 422, os caminhos no handler), 6 de integração, 6 E2E |
| Suítes | 363 unitários · 90 integração · 72 E2E · 13 streaming |

**14.6 — feature flags**

| Experimento | Resultado |
|---|---|
| Bucket com 10 mil usuários simulados | 10% liga entre 8,5% e 11,5%; subir para 20% mantém todos os primeiros; duas flags a 10% se sobrepõem em menos de 20% (sorteios independentes) |
| **Mutação:** sem o nome da flag no hash | 1 teste falha: o da independência entre flags |
| **Mutação:** lista de usuários antes do kill switch | 2 testes falham: o kill switch deixou de ser absoluto |
| Adapter | 20 avaliações simultâneas = 1 leitura; kill switch vale quando o cache vence; banco fora = última configuração; nunca lida = todas desligadas |
| Comando ao vivo | Cria desligada → `--dry-run` → liga a 10% no mobile ≥ 2.15 → kill → recusa de `--rollout 150` → `--show`; 3 linhas de auditoria com quem fez cada mudança; o kill manteve a regra |
| `GET /me/features` (E2E) | Só o resultado (a lista de testadores não vaza); desligada fora da lista, na web e no app 2.14; kill switch na resposta seguinte; 401 sem token |
| oasdiff contra a `main` | 0 incompatíveis (rota nova) |
| Testes novos | 15 unitários, 5 de integração, 4 E2E |
| Suítes | 378 unitários · 95 integração · 76 E2E · 13 streaming |

**14.7 — rollout da `task-list-with-stats`** (API em `node dist/main`, flag em 50%)

| Experimento | Resultado |
|---|---|
| 40 usuários, 15 listagens cada | 19 caíram em `with-stats` e 21 em `control`; 285 + 315 = 600 requisições contadas, sem sobra |
| p95 da primeira página, no Prometheus | `control` 4,77 ms × `with-stats` 4,80 ms: a consulta a mais quase não custa, e o critério estaria cumprido |
| Kill switch com tráfego novo (10 usuários × 5) | `with-stats` parou em 285; as 50 listagens novas foram para `control` (315 → 365) |
| 1ª tentativa da demo | 9 de 20 usuários "sem stats" eram cadastros recusados (nome com menos de 3 caracteres) e listagens com 401: o script contava falha como controle (problema 15) |
| Alertas com `promtool` | Regressão real dispara aos 25 min (pendente aos 10); ruído de 5 ms, tráfego de 3 req/min e o `for` não disparam; erro só na variante, sem erro no controle, dispara |
| **Mutação:** sem o `or vector(0)` no controle | O teste do `TaskListStatsErrors` falha (o alerta não dispara) |
| oasdiff contra a `main` | 0 incompatíveis (`stats` opcional novo na resposta) |
| Testes novos | 6 unitários (o handler com e sem `stats`, a métrica por variante), 3 E2E, 4 casos de alerta |
| Suítes | 384 unitários · 95 integração (o teste dos alertas no `promtool` incluso) · 79 E2E · 13 streaming |

**14.8 — a política**

| Experimento | Resultado |
|---|---|
| Teste da política de depreciação | A lista real (vazia) passa; com exemplos, 89 dias de aviso falham, 90 e o `dueDate` (97) passam |
| Descrição do Swagger | Ganhou o parágrafo da compatibilidade (leitor tolerante, 90 dias, 6 meses); oasdiff: só a descrição mudou |
| Suítes | 386 unitários (2 novos) · 95 integração · 79 E2E · 13 streaming |

**Correção do log de acesso (problema 17)**

| Experimento | Resultado |
|---|---|
| Ao vivo (`node dist/main`, `X-Platform: android`) | 201, 426 e 404: `"client"` **1×** em cada linha de acesso (antes: 2×) |
| Teste da linha crua | 201, 426 e 500 com 1 ocorrência; sem cliente validado, nenhuma, e o header forjado fora do log. Mutação (o `customProps` antigo): 3 vermelhos, "Received length: 2" |
| Suítes | 389 unitários (4 novos, 1 substituído) |

---

## 🔄 Como este módulo evoluiu com o projeto

| Antes | Hoje | Por quê |
|---|---|---|
| A API não sabia quem a chamava | **(14.1)** Plataforma e versão em cada request: no span, no log e numa métrica de adoção | Pré-requisito de qualquer política de compatibilidade (14.2 em diante) |
| `correlation.id` no span do middleware | **(14.1)** No span do request, junto com o cliente | Atributo de request tem que estar no span do request |
| Nenhuma forma de parar uma versão quebrada do app | **(14.2)** Mínima e recomendada por plataforma, mudadas por comando com auditoria e valendo em até 30 s, sem deploy | Uma correção na loja não chega a quem não atualiza; o servidor precisa poder dizer "atualize" |
| O contrato da API só existia em `/docs`, gerado na hora | **(14.3)** `docs/api/openapi.json` versionado, conferido no CI, e mudanças incompatíveis bloqueadas sem a label `breaking-change` | Mudar o contrato passa a ser uma decisão visível no PR, e não um efeito colateral |
| Prazo só como instante (`dueDate`), sem o fuso do usuário | **(14.4a)** `due { at, timezone }` ao lado do `dueDate` depreciado, nos dois sentidos; `TaskCreated` v2 com o primeiro *upcaster* do projeto | Lembrete "vence hoje" precisa do fuso; e a mudança mostra o expand/contract inteiro (API, evento, banco, contrato público) |
| `dueDate` e `due` lado a lado na API | **(14.4b)** Só `due`; a `due_date` sem uso, esperando o `DROP` num deploy separado; política de depreciação no ADR-0008 | Contract com os três critérios cumpridos; e o aprendizado de que o CI não substitui a política |
| Coluna `due_date` sem uso; respostas prometendo menos do que entregam | **(14.4c)** Coluna removida (com `lock_timeout` e checagem anti-perda); campos sempre presentes como `required` | Fecha o expand/contract e o achado do oasdiff: uma remoção futura desses campos é pega pelo CI |
| Repetir o `POST /tasks` criava outra tarefa | **(14.5)** `Idempotency-Key`: a mesma chave devolve a mesma resposta; a chave gravada na transação da tarefa | A rede do celular falha no meio; o cliente precisa poder repetir sem medo |
| Toda funcionalidade nova ia para todos de uma vez, e desligar exigia deploy (e loja) | **(14.6)** Feature flags com kill switch, restrições, lista de usuários e porcentagem; `GET /me/features` | Liberar aos poucos e desligar em segundos, sem depender da aprovação da loja |
| Flags existiam, sem nenhuma funcionalidade atrás | **(14.7)** `stats` na listagem atrás da `task-list-with-stats`, medido por variante, com critério de avanço e alertas | Liberar é decidir com números; e a flag nasce com data para sair |
| Ferramentas de compatibilidade sem uma regra que dissesse quando usar cada uma | **(14.8)** A política em uma página: sem versão na URL por padrão, janela de 6 meses, 90 dias de aviso no CI, o mapa de decisão | Responder "como vocês versionam a API?" com uma política, e não com uma lista de ferramentas |
| CORS só com `Content-Type`, `Authorization` e `X-Correlation-Id` | **(14.1)** Também `X-Platform` e `X-App-Version` | Sem isso, o preflight barraria o front web que os envia |

---

## 🚧 Limitações e próximos passos

- **Headers não provam nada:** a versão e a plataforma são declaradas pelo cliente. Provar que a chamada vem do app
  legítimo exigiria *app attestation* (App Attest, Play Integrity), com o token verificado no servidor.
- **Cardinalidade contida, não eliminada:** um cliente mal-intencionado ainda cria até ~10 mil séries por plataforma.
  O próximo passo seria aceitar como label só os releases conhecidos (lista configurável), e `other` para o resto.
- **Sem número de build:** duas compilações da mesma versão de loja (um hotfix por *code push*, por exemplo) são
  indistinguíveis. Um `X-App-Build` resolveria, se aparecer o caso.
- **Janela de até 30 s entre réplicas:** cada réplica tem o seu cache, então logo depois de uma mudança uma pode
  bloquear e outra não. Para invalidar na hora, seria preciso um aviso entre réplicas (`LISTEN/NOTIFY` no Postgres ou
  pub/sub), que não compensa para uma mudança mensal.
- **O oasdiff vê o que o OpenAPI descreve:** uma mudança de comportamento que não aparece no contrato (um campo que
  continua `string` mas muda de formato, uma regra de negócio nova) passa. Para isso, testes de contrato do lado do
  consumidor (*consumer-driven contracts*, como o Pact) seriam o próximo passo.
- **O `dueDate` continua no contrato público do tópico** (derivado do `due`): tirá-lo é mudança incompatível de um
  contrato que outros serviços leem (`eventVersion` 2 ou tópico `.v2`), fora do escopo.
- **O histórico devolve o `data` dos eventos já convertido** (v2): quem lê a linha do tempo vê o `due`, não o `dueDate`
  que foi gravado. É coerente com o contrato atual; o payload original continua no banco.
- **Não dá para medir quem LÊ o campo antigo**, só quem o envia. Daí o contract depender da versão mínima.
- **Só o `POST /tasks` tem `Idempotency-Key`.** Os comandos de ciclo de vida não duplicam efeito (a regra de domínio),
  mas concluir de novo responde 409 em vez da mesma resposta. Outro endpoint de criação segue a mesma receita.
- **Idempotência só para efeito no mesmo banco** (ver o ADR-0009).
- **Flags sem interface e sem experimentos** (ADR-0010): só um engenheiro muda uma flag, e comparar as variantes é
  feito pelas métricas (14.7). Segmentação só por usuário, plataforma e versão.
- **A `task-list-with-stats` ainda é uma flag**: pelo ADR-0011, ela sai depois de 2 semanas em 100%, levando a métrica
  por variante e os dois alertas. Cada rollout arriscado exige a sua métrica e os seus alertas (um mecanismo genérico
  por flag seria o próximo passo).
- **Os limites do critério são escolhidos, não derivados de um SLO** (1,2× e 50 ms).
- **A janela de 6 meses não é imposta pelo código:** o `app-version` não sabe a data de lançamento de cada versão (um
  dado da loja). Quem sobe a versão mínima consulta o painel "Clientes" e a data de lançamento (ADR-0012).
- **Até 5 s de propagação** de qualquer mudança de flag, inclusive do kill switch (o cache por réplica).
- **Política por comando, sem interface:** em produção, uma configuração gerenciada (AWS AppConfig) daria versões,
  rollback e deploy gradual da própria configuração.
- **Sem link da loja no 426:** o app recebe a `minVersion`, mas a API não sabe se há uma versão na loja que a
  satisfaça. Um campo `storeUrl` (ou a versão disponível por plataforma) ajudaria a tela de "atualize".

---

## ✅ Checklist

- [x] `X-Platform` e `X-App-Version` resolvidos sem nunca recusar a requisição (14.1)
- [x] Comparação de versão numérica, testada nos casos de borda (14.1)
- [x] Cliente no span do request, no log de acesso e numa métrica com cardinalidade limitada (14.1)
- [x] CORS e Swagger com os headers novos (14.1)
- [x] Versão mínima e recomendada por plataforma, sem deploy, com auditoria, *fail-open* e o 426 no log (14.2)
- [x] Contrato da API versionado e conferido no CI; mudanças incompatíveis classificadas e liberadas só com label (14.3)
- [x] Expand do `dueDate` → `due { at, timezone }`: dois formatos, depreciação sinalizada e medida, *upcaster*, backfill (14.4a)
- [x] Contract do `dueDate`, passo 1: fora da API, código sem a coluna antiga, backfill final, ADR-0008 (14.4b)
- [x] Contract, passo 2: `DROP COLUMN` num deploy separado, com `lock_timeout` e checagem anti-perda; respostas com `required` corretos (14.4c)
- [x] `Idempotency-Key` no `POST /tasks`, com a chave na mesma transação da tarefa (14.5)
- [x] Feature flags em módulo próprio, com kill switch, restrições, lista de usuários, bucket determinístico e monotônico, `GET /me/features` (14.6)
- [x] Uma funcionalidade real atrás de uma flag, medida por variante, com critério de avanço (ADR-0011) e alertas testados (14.7)
- [x] A política de versionamento e a janela de suporte (ADR-0012), com o aviso mínimo de depreciação conferido no CI (14.8)

---

**Anterior:** [Módulo 13 — Mensageria e streaming de eventos com Kafka](13-mensageria-kafka.md) ·
**Índice:** [Trilha de estudos](README.md)
