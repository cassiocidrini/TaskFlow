# Módulo 03 — CI/CD com GitHub Actions

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 24/11/2026
>
> **Onde vive no código:** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) ·
> [`prisma.config.ts`](../../prisma.config.ts) · [`jest.config.ts`](../../jest.config.ts) · [`package.json`](../../package.json) (scripts) ·
> [`Dockerfile`](../../Dockerfile) · [`.dockerignore`](../../.dockerignore) · [`scripts/docker/image-smoke.mjs`](../../scripts/docker/image-smoke.mjs) ·
> [`.github/dependabot.yml`](../../.github/dependabot.yml) · [`.github/workflows/codeql.yml`](../../.github/workflows/codeql.yml)

---

## 🎯 Objetivo

Montar uma esteira de **Integração Contínua** que valida **todo** push e pull request para a `main`:

- tipos (`tsc --noEmit`), lint (`oxlint`) e build;
- testes **unitários**, de **integração** e **E2E**, os dois últimos contra **PostgreSQL real** (Testcontainers);
- a **imagem de produção** construída e executada em todo PR (Etapa E.1);
- a **cadeia de suprimentos** vigiada em camadas: `npm audit`, Trivy, Dependabot, CodeQL e actions fixadas por SHA
  (Etapa E.2);
- **merge bloqueado** se qualquer verificação falhar (Ruleset da `main`).

**Por que importa:** CI é a primeira linha de defesa contra regressões. Ele também é o que torna seguro trabalhar
em equipe: ninguém precisa "confiar" que o colega rodou os testes, porque o pipeline prova.

---

## 🧠 Conceitos

### CI × CD

| Sigla | Nome | O que faz | No TaskFlow |
|---|---|---|---|
| **CI** | Integração Contínua | Valida automaticamente cada mudança | ✅ |
| **CD** | Entrega Contínua | Deixa cada versão aprovada **pronta** para deploy | ⏳ a imagem é construída e testada em todo PR; falta publicá-la |
| **CD** | Deploy Contínuo | Publica em produção automaticamente | ❌ ainda não |

### Vocabulário do GitHub Actions

| Termo | O que é |
|---|---|
| **Workflow** | Um arquivo YAML em `.github/workflows/` (aqui: `ci.yml`) |
| **Evento** | O gatilho (`push`, `pull_request`…) |
| **Job** | Um conjunto de passos que roda numa **máquina própria**; jobs diferentes rodam **em paralelo** por padrão |
| **Step** | Um comando (`run:`) ou uma action reutilizável (`uses:`) |
| **Runner** | A VM que executa o job (aqui `ubuntu-latest`); começa **limpa** a cada execução |

Como o runner começa vazio, todo job precisa: fazer *checkout* do código → instalar o Node → `npm ci` → rodar os comandos.

### `npm ci` × `npm install`

O `npm ci` instala **exatamente** o que está no `package-lock.json`, apaga o `node_modules` antes e falha se o lock
estiver dessincronizado. Resultado: builds **reprodutíveis**. O `npm install` pode atualizar versões dentro das
faixas do `package.json`, e o CI testaria algo diferente do que você testou.

---

## 🏗️ Arquitetura do pipeline

```mermaid
flowchart LR
    E["push / pull_request<br/>para a main"] --> Q
    E --> I
    E --> X
    E --> S
    E --> D
    subgraph Q [job: quality]
        direction TB
        q1[tsc --noEmit] --> q2[oxlint] --> q3[testes unitários] --> q4["nest build +<br/>contrato da API"]
    end
    subgraph I [job: integration]
        i1["Testcontainers<br/>PostgreSQL real"]
    end
    subgraph X [job: e2e]
        x1["HTTP + PostgreSQL real"]
    end
    subgraph S [job: streaming]
        s1["Kafka + PostgreSQL reais<br/>(Módulo 13)"]
    end
    subgraph D [job: image]
        d1[hadolint] --> d2["build + smoke<br/>(Etapa E.1)"]
    end
    Q --> M{5 verdes?}
    I --> M
    X --> M
    S --> M
    D --> M
    M -->|sim| OK[merge liberado]
    M -->|não| NO[merge bloqueado]
```

**Por que jobs separados, e não um:**

| | Um job sequencial | Jobs paralelos |
|---|---|---|
| Feedback de um erro de lint | Espera os containers dos testes | Aparece em ~1 min no `quality` |
| Qual parte quebrou | Ler o log inteiro | O **nome** do job vermelho já diz |
| Tempo total | Soma de tudo | O tempo do job **mais lento** |
| Custo | 1 VM | Uma VM por job (cada uma repete `npm ci` + `prisma generate`) |

**O 4º job, `streaming` (Módulo 13.3).** A suíte `test:streaming` sobe um **Kafka real** (`apache/kafka:4.3.2`, a
mesma imagem do compose) além do Postgres, e prova o caminho outbox → relay → tópico. Ganhou job próprio, em vez de
entrar no de integração, pelos mesmos motivos da tabela: só ela paga o custo do broker (~400 MB, ~10 s de boot), e
um vermelho nela aponta direto para a mensageria. Com a 13.5, a suíte passou de ~19 s para ~54 s (~61 s com o `reports` da 13.6a, ~75 s com o redrive da 13.6c). Desde a 13.6d, o job de **integração** também testa as regras de alerta do Prometheus (`promtool test rules` num container): um alerta quebrado bloqueia o merge como um teste de código: o teste do DLT
indisponível espera um timeout **real** do produtor (10 s), porque é a única forma de provar que a mensagem não sai da
partição sem o ack.

---

## 📋 O workflow atual, comentado

```yaml
on:
  push:         { branches: [main, master] }
  pull_request: { branches: [main, master] }

# Menor privilégio: o CI só precisa LER o código (OWASP A08 — integridade do pipeline)
permissions:
  contents: read

# Um push novo no mesmo PR cancela o run anterior (não gasta minutos validando código obsoleto)
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  quality:
    name: Tipos, lint, unitários e build
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24', cache: 'npm' }
      - run: npm ci
      - run: npx prisma generate
      - run: npx tsc --noEmit
      - run: npm run lint
      - run: npm run test:unit
      - run: npm run openapi:check   # build + snapshot do OpenAPI (Módulo 14.3)

  integration:   # mesmo setup + npm run test:integration
  e2e:           # mesmo setup + npm run test:e2e
  streaming:     # mesmo setup + npm run test:streaming (Kafka + Postgres via Testcontainers)
```

| Step | Por quê |
|---|---|
| `setup-node` com `cache: 'npm'` | Reaproveita o cache de pacotes entre execuções (instalação mais rápida) |
| `npx prisma generate` | Gera o client tipado; sem ele, nada que importe `@prisma/client` compila |
| `npx tsc --noEmit` | O `ts-jest` só **transpila**: erros de tipo passam nos testes e só o `tsc` pega |
| `npm run lint` | `oxlint --type-aware --deny-warnings`: regras que usam tipos, como `no-floating-promises` (Promise esquecida sem `await`) e `no-explicit-any`. Com `--deny-warnings`, um *warning* também falha o job: warning que não bloqueia vira ruído e se acumula |
| `npm run openapi:check` | Faz o `nest build` (com o plugin do Swagger) e confere se o contrato gerado bate com `docs/api/openapi.json` (Módulo 14.3): mudar a API sem atualizar o snapshot falha aqui |

### O workflow do contrato da API (Módulo 14.3)

[`api-contract.yml`](../../.github/workflows/api-contract.yml) roda o **oasdiff** entre o `docs/api/openapi.json` da base
do PR e o do PR, e falha numa mudança incompatível, a menos que o PR tenha a label `breaking-change`. É um workflow
**separado** porque reage a `labeled`/`unlabeled`: no `ci.yml`, pôr uma label dispararia de novo os quatro jobs. O
valor da label entra no shell como **booleano calculado pelo GitHub** (`contains(...)`), nunca como texto do PR: nada
que o autor do PR escreve vira comando (*script injection* em Actions). Validado com o `actionlint`.

### O CI sem `.env`

O `.env` está no `.gitignore`, então **o runner não o tem**. Duas consequências:

1. **`prisma.config.ts`** usa um *placeholder*, porque o `prisma generate` lê a configuração mas não conecta no banco:

   ```ts
   url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
   ```

2. **Testes de integração e E2E** sobem o próprio PostgreSQL com Testcontainers e definem as variáveis de ambiente
   **antes** de carregar o `AppModule`. A app valida o ambiente no boot, então um import antecipado quebraria
   justamente no CI, onde não há `.env` para mascarar o problema (detalhes no [Módulo 07](07-testes.md)).

> O runner `ubuntu-latest` do GitHub já vem com Docker, e por isso o Testcontainers funciona no CI sem configuração extra.

---

## 🐳 A imagem de produção (Etapa E.1)

### O que havia

O `Dockerfile` tinha dois estágios e parecia razoável. Construído e inspecionado em 24/11/2026:

| Achado | Consequência |
|---|---|
| `node:20-alpine` | O projeto exige Node 24 (`engines`, `.nvmrc`, CI): a imagem rodava uma versão que nenhum teste usa |
| **Sem `.dockerignore`** + `COPY . .` | O estágio de build tinha o **`.env` com o `JWT_SECRET`** e o `.git` inteiro. E o `node_modules` do host (782 MB) **sobrescrevia** o do `npm ci`, com binários nativos compilados para outra libc (glibc no host, musl no Alpine) |
| Runtime com o `node_modules` do build | jest, testcontainers, ts-node e a CLI do Prisma em produção: **1.248 MB** e **51 CVEs HIGH/CRITICAL** (Trivy) |
| Sem `USER` | O processo rodava como **root** (uid 0) |
| Sem `HEALTHCHECK` | Os probes do Módulo 01 existiam, mas nada os chamava |

**A causa comum:** nada construía nem rodava essa imagem. O Dockerfile ficou para trás quando o projeto foi para o
Node 24, e ninguém percebeu. **Arquivo que nada executa apodrece em silêncio**, e por isso a correção inclui um job
no CI.

### O Dockerfile novo

```text
base       node:24.22.2-alpine3.24@sha256:…  (tag exata E digest, escritos uma vez só)
deps       npm ci (todas as dependências; cache do npm montado pelo BuildKit)
build      prisma generate + nest build (o plugin do Swagger só roda no nest build)
prod-deps  npm ci --omit=dev --omit=optional + o client gerado do Prisma
migrate    docker build --target migrate → prisma migrate deploy (como usuário node)
runtime    NODE_ENV=production · sem npm/yarn/corepack · código do root · USER 1000:1000
           HEALTHCHECK em /health/live · CMD ["node", "dist/main"]
```

| Decisão | Por quê |
|---|---|
| **`.dockerignore` como allowlist** (`*` e depois `!src/`, `!prisma/`...) | Numa lista do que excluir, cada arquivo novo (um `.env.local`, uma chave) entra na imagem até alguém lembrar de listá-lo. Mais os `COPY` explícitos: duas proteções independentes (o Dockerfile antigo com o `.dockerignore` novo já não leva o `.env`) |
| **Tag exata + digest** | Uma tag móvel (`node:24-alpine`) muda por baixo sem nenhum commit; o build de amanhã deixa de ser o que foi testado hoje. Num estágio `base`, e não num `ARG`: o hadolint e o Dependabot não leem a tag dentro de `${...}` |
| **`--omit=optional` também** | O `@prisma/client` declara `prisma` e `typescript` como peers **opcionais**; sendo devDependencies da raiz, o lockfile os marca `devOptional`. Só com `--omit=dev`, 102 pacotes de desenvolvimento (a CLI do Prisma, o Studio, o TypeScript) iam para produção: 605 → 373 MB de `node_modules` |
| **Código do root, processo do `node` (uid 1000)** | O processo lê o próprio código, mas não o altera: uma invasão da API não persiste nada em `dist/`. Com `COPY --chown=node`, ele poderia. **Numérico** (`USER 1000:1000`, E.2): com `runAsNonRoot: true`, o Kubernetes só confere que o usuário não é root se o uid for um número, e recusa o pod com `USER node` (regra DL3066 do hadolint) |
| **Sem npm, yarn e corepack no runtime** | O `CMD` é `node`. Saem 6 CVEs (undici e brace-expansion empacotados no npm) e o instalador de pacotes que um invasor usaria. **Não reduz o tamanho:** o `rm` numa camada posterior só esconde os arquivos (*whiteout*); os bytes continuam na camada da imagem base |
| **`HEALTHCHECK` no *live*, não no *ready*** | O *ready* depende do banco. Com o banco fora, todas as réplicas ficariam *unhealthy* ao mesmo tempo, e um orquestrador que reinicia *unhealthy* derrubaria todas por um problema que não é delas. O teste usa o `fetch` do Node, sem instalar `curl` |
| **Migração em target separado** | Com várias réplicas, cada uma migraria ao subir (corrida), e a API precisaria de permissão de DDL. Roda uma vez antes do deploy; no Kubernetes, um Job (Módulo 02) |
| **Uma imagem para todos os processos** | API, relay, consumers e CLIs são o mesmo artefato testado; muda só o comando (`docker run <imagem> node dist/relay`). Um worker roda com `--no-healthcheck` (não escuta a porta 3000) |
| **`CMD` em forma exec, com `node` direto** | O node é o PID 1 e recebe o SIGTERM, que dispara o graceful shutdown do Módulo 01 (medições abaixo) |

### O PID 1 e o `docker stop`, medido

O `docker stop` manda SIGTERM ao **PID 1** do container e, se ele não sair em 10 s, SIGKILL. Quem é o PID 1 decide
se o graceful shutdown roda:

| `CMD` | PID 1 | `docker stop` | Exit | Graceful shutdown |
|---|---|---|---:|:---:|
| `["node", "dist/main"]` (o adotado) | node | **0,15 s** | 0 | ✅ |
| `node dist/main` (forma shell, um comando só) | node (o `sh` do Alpine faz `exec`) | 0,16 s | 0 | ✅ |
| `node dist/main; echo saiu` (o shell continua vivo) | `/bin/sh` | **10,14 s** | **137** (SIGKILL) | ❌ |
| `["npm", "run", "start:prod"]` | npm | 0,67 s | **1** | ✅ |

O caso que quebra é um **shell que continua vivo** como PID 1: ele não repassa o sinal, e as requisições em andamento
são cortadas pelo SIGKILL. Com o npm 11, o sinal chega, mas o container sai com **1**: para o orquestrador, todo
deploy vira um encerramento com falha.

> **Lição de método:** o desenho desta etapa afirmava que "com o npm no meio, o sinal não chega". A medição
> desmentiu: o npm 11 repassa o SIGTERM. O comentário do Dockerfile foi corrigido para o que foi medido, e a tabela
> mostra o caso que realmente quebra.

### O smoke test e o job `image`

[`scripts/docker/image-smoke.mjs`](../../scripts/docker/image-smoke.mjs) (`npm run docker:smoke`, o mesmo no CI e na
máquina) constrói a imagem e, numa rede Docker própria com um Postgres vazio, verifica 7 propriedades: o target
`migrate` aplica as migrações; a API fica `healthy`; o `/health/ready` responde 200; o uid é 1000; não há escrita em
`dist/`; não há npm; e o `docker stop` termina com exit 0 em menos de 5 s, com o log da drenagem.

O job `image` do CI roda o hadolint, o Trivy (E.2) e esse smoke. **Mutação:** sem o `USER` e com o `CMD` em forma shell
(`node dist/main; echo saiu`), o smoke falha em 3 verificações: uid 0, escrita em `dist/` e `exit 137, 10.14 s`.

### Como reproduzir

```bash
npm run docker:smoke                                   # o teste completo (~1 min com cache)
docker build -t taskflow .                             # a imagem da API
docker build --target migrate -t taskflow:migrate .    # a imagem da migração
docker run --rm -e DATABASE_URL=... taskflow:migrate   # aplica as migrações
docker run --rm --no-healthcheck -e DATABASE_URL=... -e KAFKA_BROKERS=... taskflow node dist/relay
docker run --rm -i hadolint/hadolint:v2.15.1 < Dockerfile
```

### Perguntas de entrevista

- **"Por que o seu container não roda como root?"** Porque uma falha na aplicação daria root no container, e um
  escape do container ficaria mais perto do host. Roda como uid 1000, e o código pertence ao root: o processo nem
  consegue alterar o próprio código.
- **"O que acontece no `docker stop`?"** SIGTERM no PID 1 e SIGKILL depois de 10 s. Se o PID 1 for um shell que não
  repassa o sinal, a aplicação nunca fica sabendo, e as requisições em andamento morrem. Medi: 10,14 s e exit 137.
- **"Onde rodam as migrações?"** Num passo separado, uma vez antes do deploy, e nunca no boot de cada réplica.
- **"Liveness ou readiness no healthcheck?"** Liveness: com o banco fora, readiness derrubaria todas as réplicas
  juntas.
- **"Como você reduziu a imagem?"** Multi-stage, só dependências de produção, e descobrindo o `devOptional`. E sei que
  `rm` numa camada posterior não reduz o tamanho, só esconde os arquivos.

---

## 🔗 Cadeia de suprimentos (Etapa E.2)

O código que roda em produção é quase todo de outras pessoas: ~370 MB de `node_modules`, a imagem base, as actions do
CI e as ferramentas que elas executam. A defesa é em camadas, cada uma olhando uma coisa diferente:

| Camada | Ferramenta | Olha | Bloqueia o merge? |
|---|---|---|---|
| Código | `npm audit --omit=dev --audit-level=high` (job `quality`) | As dependências de **produção**, pelo lockfile | ✅ HIGH ou CRITICAL |
| Artefato | Trivy (job `image`), `--ignore-unfixed` | A imagem **como vai para produção**: Alpine, Node e `node_modules` | ✅ HIGH ou CRITICAL com correção |
| Atualização | Dependabot (`.github/dependabot.yml`) | npm, actions, a imagem base e o compose, toda semana | — (abre PRs; o CI decide) |
| Nosso código | CodeQL (`security-extended`) | Injeção, SSRF, ReDoS: dado do usuário chegando a um ponto perigoso | Pelo Ruleset (*code scanning*) |
| Imutabilidade | Actions por **SHA**; hadolint, Trivy e oasdiff por **tag + digest** | O que o CI executa | — |

### As decisões

| Decisão | Por quê |
|---|---|
| **Portão só em produção** (`--omit=dev`) | As devDependencies não vão para a imagem. Bloquear por elas (eram 46 no total contra 16 em produção) gera ruído, e um portão barulhento ensina o time a ignorá-lo |
| **Dois portões, código e artefato** | O `npm audit` não enxerga o Alpine nem o Node da imagem; o Trivy não roda sem construir a imagem. Um pega cedo e barato, o outro pega o que realmente vai para o ar |
| **`--ignore-unfixed` no Trivy** | Uma CVE sem versão corrigida não tem ação possível; bloquearia todo PR até o mantenedor publicar uma correção |
| **Dependabot semanal e agrupado** | Um PR por família (Nest, OpenTelemetry, Prisma, AWS SDK e "outras") com minor e patch; major sozinho, porque precisa de changelog. Sem grupos, seriam dezenas de PRs por semana, e PR que ninguém revisa vira merge sem olhar |
| **Actions por SHA** | Uma tag é um ponteiro que o dono (ou um invasor com acesso ao repositório dele) pode mover. Em 2025, as tags do `tj-actions/changed-files` foram movidas para um commit que vazava segredos de milhares de pipelines. Um SHA não muda. O comentário `# v7.0.1` diz a versão, e o Dependabot atualiza os dois |
| **CodeQL no repositório** (*advanced setup*) | A configuração fica versionada e revisada em PR, com as actions fixadas como o resto. O *default setup* da interface funcionaria, mas fora do código |
| **`overrides` do `effect`** | O `@prisma/config` 7.10.1 fixa `effect@3.20.0` exato (ReDoS, HIGH). A correção (3.22.1) é do mesmo major, mas o npm só oferecia **voltar o Prisma para a 6.12**. O `overrides` força a versão corrigida. **Remover** quando o Prisma atualizar o `effect` (o `npm ls effect` mostra quem pede qual) |

### Antes × depois

| | `main` antes da E.2 | Depois |
|---|---|---|
| `npm audit`, produção | 16 (9 HIGH, 7 moderadas) | **0** |
| `npm audit`, tudo | 46 (11 HIGH) | 31 (2 HIGH, só em dev) |
| Imagem (Trivy 0.76.2, a mesma régua) | 5 HIGH, 10 MEDIUM | **0 HIGH**, 7 MEDIUM |
| Actions | `@v4` (tag) | v7, por SHA |

O `npm audit fix` (sem `--force`) mudou 54 pacotes, todos dentro das faixas do `package.json`. **Mutação:** com o
lockfile antigo, o portão do `npm audit` sai com 1; com o novo, 0.

### O que fica na configuração do repositório

Não é código, então fica com quem administra o repositório (*Settings*):
- **Code security → Dependabot security updates:** ligado. Um PR de correção sai quando a CVE é publicada, sem
  esperar a segunda-feira.
- **Rules → Rulesets → main → Require code scanning results:** CodeQL, bloqueando alertas de segurança *High or
  higher*. O check do CodeQL sempre "passa" (a análise roda); o que bloqueia é o achado, e isso é regra de *code
  scanning*, não de *status check*.

### A primeira rodada do Dependabot

Ao entrar na `main`, o Dependabot não esperou a segunda-feira: abriu 13 PRs de uma vez (6 de imagens, 5 grupos do
npm e 2 majors). Os vermelhos eram os portões funcionando:

| PR | Falhou em | O que o portão pegou |
|---|---|---|
| Prometheus v3.15 → v3.16 | integração | O teste que exige a imagem do `promtool` igual à do compose: o Dependabot só trocou o compose |
| Node 24 → 26 na imagem | job `image` | O `npm ci` quebra dentro da imagem com o Node 26 (sem o smoke da E.1, verde) |
| Grupo `nestjs` | `openapi:check` | O `@nestjs/terminus` novo mudou o schema do `/health` no OpenAPI: o portão de contrato (14.3) pegou uma mudança de API vinda de **dependência** |
| Grupo `opentelemetry` | `npm ci` (`ERESOLVE`) | O grupo subiu pacotes que precisam andar juntos e o resolvedor recusou a combinação |

**O verde que preocupava:** o Postgres 16 → 18 passou em todos os checks, porque os testes sobem o próprio Postgres
16.15 pelo Testcontainers. Só o Prometheus tinha a guarda "imagem do teste = imagem do compose"; para o Postgres e o
Kafka, havia apenas um comentário. Duas correções:

- **[`test-images.spec.ts`](../../test/unit/test-images.spec.ts)** (unitário, sem Docker): as imagens de Postgres,
  Kafka e Prometheus dos testes, e a do Postgres do smoke, têm de ser as do compose. Um PR que mexa só no compose
  falha no primeiro minuto do CI e diz o que alinhar. **Mutação:** o compose com o Postgres 18.6 e o Kafka 4.4.0
  (os dois PRs do Dependabot) deixa 3 testes vermelhos.
- **Major de imagem fora do Dependabot** (`ignore` de `version-update:semver-major` em `docker` e
  `docker-compose`, e no `@types/node`, que segue o major do runtime). Node 24 → 26 mexe no `.nvmrc`, no `engines`,
  no CI e na imagem juntos; Postgres 16 → 18 não abre o volume antigo. É decisão de projeto, num PR planejado.

### Imagens fora do Dependabot (revisão manual)

O Dependabot lê `uses:`, Dockerfile e compose, mas não comandos dentro de `run:`. Revise a cada poucos meses:

| Imagem | Onde | Versão |
|---|---|---|
| `hadolint/hadolint` | `ci.yml` (job `image`) | v2.15.1 |
| `aquasec/trivy` | `ci.yml` (job `image`) | 0.76.2 |
| `tufin/oasdiff` | `api-contract.yml` e `scripts/openapi/diff.mjs` (a mesma nos dois) | v1.37.0 |
| `postgres` | `scripts/docker/image-smoke.mjs` e `test/support/postgres-image.ts` | 16.15 (o mesmo do compose) |

### Perguntas de entrevista

- **"Como você lida com dependências vulneráveis?"** Em camadas: portão no código (`npm audit`, só produção), portão
  no artefato (Trivy), atualização contínua agrupada (Dependabot) e análise do nosso código (CodeQL).
- **"Por que fixar a action por SHA?"** Porque a tag é um ponteiro móvel, e o caso do `tj-actions` mostrou o estrago.
- **"O `npm audit fix` sugeriu voltar um major. E aí?"** Olhei a cadeia (`npm ls`): a correção estava no mesmo major
  da dependência transitiva, então usei `overrides`, com a condição de remoção escrita.
- **"Bloquear por vulnerabilidade de devDependency?"** Não: não chega à produção, e portão barulhento é ignorado.

---

## 🔒 Proteção da `main` (Ruleset)

A proteção é um **Ruleset** (*Settings → Rules → Rulesets*), o formato que o GitHub recomenda no lugar da "regra
clássica" de Branch Protection. A configuração, como a API do GitHub a devolve
(`gh api repos/{owner}/{repo}/rulesets/<id>`):

```text
Ruleset "main" · enforcement: active · bypass: ninguém · alvo: ~DEFAULT_BRANCH
✅ Restrict deletions                       (deletion)
✅ Block force pushes                       (non_fast_forward)
✅ Require a pull request before merging    (pull_request, 0 aprovações: projeto de uma pessoa só)
✅ Require status checks to pass            (required_status_checks, strict = branch atualizada com a main)
   • Tipos, lint, unitários e build
   • Testes de integração (Testcontainers)
   • Testes E2E (Testcontainers)
   • Testes de streaming (Kafka + Postgres, Testcontainers)
   • Mudanças incompatíveis no contrato da API   (Módulo 14.3)
   • Imagem Docker (hadolint e smoke)            (Etapa E.1)
   • CodeQL                                      (Etapa E.2; publicado pelo code scanning, não pelas Actions)
```

> Conferido pela API em 24/11/2026: 7 checks. O `CodeQL` entrou como *status check* (o check run que o code
> scanning publica reprova quando a análise acha alerta acima do limite de *Protection rules*, padrão *High or
> higher*), e não como a regra *Require code scanning results*: os dois caminhos bloqueiam o mesmo achado.

> ⚠️ **Achado em 10/11/2026:** ao incluir o 4º check, a tela de Branch Protection estava **vazia** e a API respondia
> `Branch not protected`. A regra descrita nas versões anteriores deste módulo não existia (não dá para saber desde
> quando), e a `main` aceitava push direto. O Ruleset acima foi criado nesse dia.
> Lição: configuração fora do código também precisa ser **verificada**, não só documentada; o `gh api` torna isso um
> comando.
>
> **0 aprovações** é deliberado: com 1, o próprio autor não consegue aprovar o PR e o merge trava. Num time, 1 ou 2.

| Ação | Resultado |
|---|---|
| Push direto na `main` | ❌ Bloqueado (só via PR) |
| PR com qualquer job vermelho | ❌ Merge bloqueado |
| PR com os 7 checks verdes | ✅ Merge liberado |

> ⚠️ **Armadilha ao renomear jobs:** o check obrigatório é identificado pelo **nome** do job. Quando o job único
> `Build & Test` virou três jobs, o check antigo **nunca mais reportaria**, e o PR ficaria travado em
> *"Expected — Waiting for status to be reported"*. Depois de renomear, rode o CI uma vez e atualize a lista de checks.
>
> O mesmo vale para um job **novo**: o `streaming` (13.3) só passa a bloquear o merge depois de adicionado à lista de
> checks obrigatórios, e ele só aparece na lista depois de rodar uma vez.

### Níveis de rigor

| Nível | Configuração | Quando usar |
|---|---|---|
| Light | CI roda, mas não bloqueia | Protótipo solo |
| Médio | CI bloqueia o merge | Projeto solo sério (**o TaskFlow**) |
| Rigoroso | + PR obrigatório com 1 aprovação | Time profissional |
| Extremo | + 2 aprovações + commits assinados | Sistemas críticos (financeiro, saúde) |

---

## 🔁 O fluxo de trabalho na prática

Todas as correções do projeto (PRs #1 a #6) seguiram o mesmo ciclo:

```text
git switch -c feat/<assunto>      → uma branch por assunto
commits no padrão Conventional    → feat: · fix: · test: · docs: · chore:
git push -u origin feat/<assunto> → abre o PR com descrição (contexto, o que muda, testes)
CI roda os 3 jobs                 → vermelho? corrige na mesma branch
squash and merge                  → 1 PR = 1 commit na main (histórico linear)
git switch main; git pull; git fetch --prune; git branch -D feat/<assunto>
```

> Depois de um *squash*, o `git branch -d` recusa apagar a branch: os commits dela têm hashes diferentes do commit
> "esmagado" na `main`. Como o PR está *Merged*, o `-D` é seguro.

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | CI falhou no step de testes | Jest com ESM não funcionava no Node 20 | Node 24 no CI (`--experimental-vm-modules` nos scripts) |
| 2 | `exports is not defined` | Conflito ESM × `transformIgnorePatterns` | Reverter o `jest.config.ts` ao original |
| 3 | `Cannot find module @prisma/client` | Faltava gerar o client | Step `npx prisma generate` |
| 4 | Falha por falta de `.env` | `.env` está no `.gitignore` | *Placeholder* no `prisma.config.ts` |
| 5 | Lint vermelho em scripts de estudo | Os scripts de laboratório (hoje em `scripts/`, `load/` e `labs/`) também passam pelo lint | Corrigidos no próprio PR (`fix(ci): corrige erros de lint…`) |
| 6 | Cada teste rodava **duas vezes** | `npm test` (todas as suítes) **e depois** cada suíte de novo | Um script por job; cada suíte roda uma vez |
| 7 | `--passWithNoTests` mascarava suíte vazia | A flag aprova até sem nenhum teste | Removida: suíte vazia falha |
| 8 | Hook de teste estourou 5 s sob carga | `testTimeout` dentro de `projects` é **ignorado** pelo Jest | `jest.setTimeout(60_000)` em [`setup-slow-suites.ts`](../../test/setup-slow-suites.ts), só para integração/E2E |
| 9 | Docker Desktop caiu rodando todas as suítes localmente | 4+ PostgreSQL de teste + stack de dev esgotaram a memória | `--runInBand` nas suítes com Testcontainers; o CI isola cada suíte numa VM |
| 10 | O estágio de build da imagem tinha o `.env` (com o `JWT_SECRET`) e o `.git` | Sem `.dockerignore`, o `COPY . .` levava o diretório inteiro | `.dockerignore` como allowlist + `COPY` explícitos (Etapa E.1) |
| 11 | O `node_modules` do `npm ci` era sobrescrito dentro da imagem | O mesmo `COPY . .` trazia o `node_modules` do host (glibc) para o Alpine (musl) | Idem: o `node_modules` do host não entra no contexto |
| 12 | A CLI do Prisma e o TypeScript na imagem de produção, mesmo com `--omit=dev` | Peers opcionais de uma dependência de produção, que também são devDependencies, ficam `devOptional` no lockfile | `--omit=dev --omit=optional`; o smoke prova que nada de que a API precisa saiu |
| 13 | O hadolint acusou DL3006 ("sempre fixe a tag") com a tag fixada | A tag estava num `ARG` (`FROM ${NODE_IMAGE}`), que o lint não resolve | Estágio `base` com a tag escrita uma vez; os outros fazem `FROM base` |
| 14 | O desenho dizia que "o npm não repassa o SIGTERM" | Suposição antiga, não medida | Medido: o npm 11 repassa (sai com 1); o que quebra é um shell vivo como PID 1 (10,14 s, exit 137). Comentário corrigido |
| 15 | `npm audit fix` deixou 3 HIGH e sugeriu voltar o Prisma para a 6.12 | O `@prisma/config` fixa `effect@3.20.0` exato; a correção é da 3.22.1 | `overrides` no `package.json`, com condição de remoção (E.2) |
| 16 | O hadolint novo acusou DL3066 em `USER node` | Uid por nome não pode ser conferido como não-root (Kubernetes `runAsNonRoot`) | `USER 1000:1000` (E.2) |
| 17 | O npm 11.19 avisou de 10 pacotes com scripts de instalação "fora do `allowScripts`", e o manual dizia "bloqueados por padrão" | O `npm help install-scripts` contradiz o `npm help config`: o padrão é **aviso**, e os scripts rodam (o binário do Kafka foi gerado no container) | Nada quebrou; a política de scripts (`allowScripts` + `strict-allow-scripts`) ficou como próximo passo |
| 18 | O PR do Dependabot do Postgres 16 → 18 passou verde em todos os checks | Os testes sobem o Postgres do Testcontainers (16.15); nada conferia a versão do compose, só um comentário | `test-images.spec.ts` para Postgres, Kafka, Prometheus e o smoke; major de imagem no `ignore` do Dependabot |

---

## 📊 Resultados

| Momento | Execução | Resultado |
|---|---|---|
| Primeiro CI | Run #1 (setup inicial) | ❌ falhou em 36 s (Node 20 × Jest ESM) |
| | Run #2 (Node 24) | ✅ 37 s |
| Um job com unit + integração + E2E | Run #17 | ✅ 1 min 20 s |
| Três jobs paralelos | PRs #5 e #6 | ✅ todos verdes, com 150 testes por PR |
| Quatro jobs (+ `streaming`) | Módulo 13.3 | Localmente: suíte de streaming em ~7 s com as imagens em cache |
| Imagem antes × depois | Etapa E.1 | **1.248 → 707 MB**; CVEs HIGH/CRITICAL (Trivy) **51 → 5** (0 CRITICAL, 0 no Alpine); uid 0 → 1000; Node 20 → 24 |
| Primeira rodada do Dependabot | Etapa E.2 | 13 PRs; 4 vermelhos (cada um um portão funcionando) e 1 verde enganoso (Postgres 18), que virou o `test-images.spec.ts` |
| Cadeia de suprimentos | Etapa E.2 | `npm audit` de produção **16 → 0**; imagem **5 → 0 HIGH** (Trivy 0.76.2); actions por SHA; 389 unitários · 95 integração · 79 E2E · 13 streaming e o smoke verdes depois do `audit fix` |
| Cinco jobs (+ `image`) | Etapa E.1 | `npm run docker:smoke`: 7 verificações em ~1 min 13 s localmente; `docker stop` em 0,15 s com exit 0 |

---

## 🚧 Limitações e próximos passos

- **CD não implementado:** não há deploy automático. O próximo passo natural é um workflow disparado no merge para a `main` que publica a imagem Docker e faz o deploy (ex.: Render/Fly.io + Neon).
- **Scripts de instalação sem política:** o npm 11.19 roda os scripts de `postinstall` de qualquer dependência (só
  avisa). Um `allowScripts` no `package.json` com `strict-allow-scripts` faria de um script novo um erro de build
  (o vetor de worms como o Shai-Hulud, de 2025).
- **Versões do Nest desalinhadas:** o `audit fix` levou o `@nestjs/platform-express` à 12.6.0 com o `@nestjs/core`
  na 12.1.2. As suítes passam; o grupo `nestjs` do Dependabot alinha na primeira rodada.
- **`overrides` do `effect`:** dívida com prazo; sai quando o Prisma atualizar a dependência.
- **O `HEALTHCHECK` da imagem é o da API:** um worker (relay, consumers) roda com `--no-healthcheck`. No Kubernetes,
  o `HEALTHCHECK` é ignorado e as probes ficam no manifesto (Módulo 02).
- **A imagem não é publicada:** o job `image` constrói e testa, mas nenhum registry a recebe (próximo passo do CD).
- **`--omit=optional` é uma aposta conferida:** uma dependência opcional nova de que a API precise sairia da imagem;
  o smoke pega se ela quebrar o boot, não se quebrar só um caminho raro.
- **Setup repetido nos jobs de teste:** uma *composite action* eliminaria as linhas duplicadas.
- **`npm ci` baixa o binário da librdkafka do GitHub** (cliente Kafka, Módulo 13): uma dependência de rede a mais em todos os jobs.
- **Sem cobertura publicada:** o `test:cov` existe, mas o relatório não é exibido no PR.

---

## ✅ Checklist

- [x] Workflow em push e PR para a `main`
- [x] Jobs paralelos: qualidade, integração, E2E, streaming (Kafka real, Módulo 13.3) e imagem (Etapa E.1)
- [x] Testes com PostgreSQL real no CI (Testcontainers)
- [x] `permissions` mínimas e cancelamento de runs obsoletos
- [x] Ruleset na `main`: PR obrigatório, 7 checks, sem bypass, sem force push (verificado pela API do GitHub)
- [x] Badge do CI no README
- [x] Contrato da API conferido no CI e mudanças incompatíveis bloqueadas sem label (Módulo 14.3)
- [x] Imagem de produção em Node 24, não-root, com `HEALTHCHECK`, migração separada, e construída e executada no CI (Etapa E.1)
- [ ] CD (publicar a imagem e fazer o deploy)
- [x] Cadeia de suprimentos: `npm audit` e Trivy como portões, Dependabot, CodeQL e actions por SHA (Etapa E.2)

---

**Anterior:** [Módulo 01 — Observabilidade](01-observabilidade.md) ·
**Próximo:** [Módulo 04 — Modelagem NoSQL com DynamoDB](04-modelagem-nosql-dynamodb.md)
