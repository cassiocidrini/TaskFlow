# Módulo 14 — Uma API para web e apps

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 24/11/2026
>
> **Status:** 🚧 em construção, etapa **14.3 de 14.8** (o contrato da API versionado e vigiado no CI). Cada etapa acrescenta a sua parte a
> este documento; o mapa completo está em "Roteiro do módulo", logo abaixo.
>
> **Onde vive no código:** [`src/common/client/`](../../src/common/client/client-info.ts) (headers, parser de versão,
> middleware e `@AppClient()`) · [`request-span.ts`](../../src/common/telemetry/request-span.ts) ·
> [`app.setup.ts`](../../src/app.setup.ts) (registro, CORS e Swagger) ·
> [`logger.options.ts`](../../src/common/logging/logger.options.ts) (cliente no log de acesso) · painel "Clientes" em
> [`taskflow-api.json`](../../grafana/dashboards/taskflow-api.json) · versão mínima em
> [`version-gate.middleware.ts`](../../src/common/client/version-gate.middleware.ts),
> [`version-policy.service.ts`](../../src/common/client/version-policy.service.ts) e o comando
> [`src/app-version.ts`](../../src/app-version.ts) · contrato em [`docs/api/openapi.json`](../api/openapi.json),
> [`scripts/openapi/`](../../scripts/openapi/snapshot.ts) e [`api-contract.yml`](../../.github/workflows/api-contract.yml)

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

---

## 🗺️ Roteiro do módulo

| Etapa | O que entrega | Status |
|---|---|:-:|
| **14.1** | Identificação do cliente: `X-Platform` e `X-App-Version` no request, no span, no log e numa métrica com cardinalidade limitada | ✅ |
| **14.2** | Versão mínima por plataforma, configurável sem deploy (tabela + cache de 30 s + `npm run app-version` com auditoria): `426` + `APP_UPDATE_REQUIRED`; aviso de atualização recomendada | ✅ |
| **14.3** | Contrato versionado (`docs/api/openapi.json`) conferido no CI, e mudanças **incompatíveis** classificadas pelo oasdiff, liberadas só com a label `breaking-change` | ✅ |
| 14.4 | Expand/contract real: `dueDate` → `due { at, timezone }`, `Deprecation`/`Sunset`, upcaster do `TaskCreated` | 🔜 |
| 14.5 | `Idempotency-Key` no `POST /tasks` | 🔜 |
| 14.6 | Feature flags em módulo próprio (kill switch, allowlist, porcentagem) e `GET /me/features` | 🔜 |
| 14.7 | Flag `task-list-with-stats` e o critério de avanço em ADR | 🔜 |
| 14.8 | Estratégia de versionamento com janela de suporte | 🔜 |

---

## 🏗️ Arquitetura (estado atual: 14.2)

```text
                 app.use() (Express)                                  middlewares de módulo (Nest)
request ─▶ correlationId ─▶ clientInfo ─▶ helmet · cors ─▶ pino-http ─▶ VersionGate ─▶ guards (JWT…) ─▶ handler
                             │                               │            │                               │
                             ├─ req.appClient ───────────────┼─ log       ├─ abaixo da mínima: 426        └─ @AppClient()
                             ├─ span: taskflow.client.*      │  client{…} ├─ abaixo da recomendada:
                             └─ taskflow_app_requests_total  │            │  X-App-Update: recommended
                                                             │            └─ política: VersionPolicyService
                                                             │                (cache 30 s) ◀── app_version_policies
                                                             │                                 ▲
                                                             │            npm run app-version ─┘ (+ auditoria)
```

O cliente é resolvido **uma vez**, logo depois do `X-Correlation-Id`, e cada destino recebe a forma certa para ele. O
bloqueio roda depois do log de acesso (o 426 fica registrado) e antes dos guards (o app antigo recebe 426, não 401).

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
precisa rodar de novo quando a label muda, sem disparar os 4 jobs pesados do CI. Localmente: `npm run openapi:diff`,
com a mesma imagem fixada (`tufin/oasdiff:v1.37.0`).

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
exclui esses apps. Só esse último passo precisa da label.

### Em qual span gravar: o do request, não o ativo

Dentro de um middleware Express, o span **ativo** é o que o `instrumentation-express` abre para o próprio middleware
(`middleware - clientInfoMiddleware`). O primeiro teste ao vivo mostrou os atributos do cliente lá, e não no `GET /`.
O `correlation.id` do Módulo 01 sempre esteve no mesmo lugar (documentado como peculiaridade). A correção vale para os
dois: [`currentRequestSpan()`](../../src/common/telemetry/request-span.ts) pega o span do request no `rpcMetadata` que o
`instrumentation-http` guarda no contexto, o mesmo que o `RouteTelemetryGuard` usa para a rota (problema 1).

---

## 📋 Como reproduzir

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

- **Log de acesso:** cada linha da requisição traz `"client":{"platform":"ios","appVersion":"2.14.7"}`.
- **Jaeger** (`http://localhost:16686`, serviço `taskflow`): *Tags* `correlation.id=demo-14`; o span `GET /` tem
  `taskflow.client.platform` e `taskflow.client.app_version`.
- **Grafana** (`http://localhost:3001`): dashboard da API → linha **Clientes**, requisições por plataforma e por versão.
- **Swagger** (`/docs`): `X-Platform` e `X-App-Version` aparecem em todas as rotas, como parâmetros globais.

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

---

## 📊 Resultados obtidos

**14.1 — identificação do cliente** (API em `node dist/main`)

| Experimento | Resultado |
|---|---|
| 7 requisições: 3 `ios 2.14.7`, 1 `Android 2.13.1` (401), 1 `web 5.0.0`, 1 só `999.0.0`, 1 sem headers, + 1 probe | `/metrics`: `ios/2.14` = 3, `android/2.13` = 1, `web/5.0` = 1, `unknown/other` = 1, `unknown/none` = 1; o probe não contou |
| A mesma consulta no Prometheus (a do painel) | As 5 séries, com os mesmos valores |
| Log de acesso | `client` em todas as linhas, com a versão completa (`999.0.0` inclusive); o 401 também registrado |
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

---

## 🔄 Como este módulo evoluiu com o projeto

| Antes | Hoje | Por quê |
|---|---|---|
| A API não sabia quem a chamava | **(14.1)** Plataforma e versão em cada request: no span, no log e numa métrica de adoção | Pré-requisito de qualquer política de compatibilidade (14.2 em diante) |
| `correlation.id` no span do middleware | **(14.1)** No span do request, junto com o cliente | Atributo de request tem que estar no span do request |
| Nenhuma forma de parar uma versão quebrada do app | **(14.2)** Mínima e recomendada por plataforma, mudadas por comando com auditoria e valendo em até 30 s, sem deploy | Uma correção na loja não chega a quem não atualiza; o servidor precisa poder dizer "atualize" |
| O contrato da API só existia em `/docs`, gerado na hora | **(14.3)** `docs/api/openapi.json` versionado, conferido no CI, e mudanças incompatíveis bloqueadas sem a label `breaking-change` | Mudar o contrato passa a ser uma decisão visível no PR, e não um efeito colateral |
| CORS só com `Content-Type`, `Authorization` e `X-Correlation-Id` | **(14.1)** Também `X-Platform` e `X-App-Version` | Sem isso, o preflight barraria o front web que os envia |

---

## 🚧 Limitações e próximos passos

- **Headers não provam nada:** a versão e a plataforma são declaradas pelo cliente. Provar que a chamada vem do app
  legítimo exigiria *app attestation* (App Attest, Play Integrity), com o token verificado no servidor.
- **Cardinalidade contida, não eliminada:** um cliente mal-intencionado ainda cria até ~10 mil séries por plataforma.
  O próximo passo seria aceitar como label só os releases conhecidos (lista configurável), e `other` para o resto.
- **Sem número de build:** duas compilações da mesma versão de loja (um hotfix por *code push*, por exemplo) são
  indistinguíveis. Um `X-App-Build` resolveria, se aparecer o caso.
- **Nenhum handler usa o `@AppClient()` ainda:** a versão mínima (14.2) lê o cliente no middleware; o decorator entra
  na 14.4 (formato da resposta) e na 14.6 (flags por plataforma).
- **Janela de até 30 s entre réplicas:** cada réplica tem o seu cache, então logo depois de uma mudança uma pode
  bloquear e outra não. Para invalidar na hora, seria preciso um aviso entre réplicas (`LISTEN/NOTIFY` no Postgres ou
  pub/sub), que não compensa para uma mudança mensal.
- **O check do contrato não é obrigatório na proteção da `main`** até ser adicionado ao Ruleset do GitHub (decisão de
  quem administra o repositório).
- **O oasdiff vê o que o OpenAPI descreve:** uma mudança de comportamento que não aparece no contrato (um campo que
  continua `string` mas muda de formato, uma regra de negócio nova) passa. Para isso, testes de contrato do lado do
  consumidor (*consumer-driven contracts*, como o Pact) seriam o próximo passo.
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
- [ ] Expand/contract do `dueDate` (14.4)
- [ ] `Idempotency-Key` (14.5)
- [ ] Feature flags (14.6, 14.7)
- [ ] Estratégia de versionamento (14.8)

---

**Anterior:** [Módulo 13 — Mensageria e streaming de eventos com Kafka](13-mensageria-kafka.md) ·
**Índice:** [Trilha de estudos](README.md)
