# Módulo 03 — CI/CD com GitHub Actions

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) ·
> [`prisma.config.ts`](../../prisma.config.ts) · [`jest.config.ts`](../../jest.config.ts) · [`package.json`](../../package.json) (scripts)

---

## 🎯 Objetivo

Montar uma esteira de **Integração Contínua** que valida **todo** push e pull request para a `main`:

- tipos (`tsc --noEmit`), lint (`oxlint`) e build;
- testes **unitários**, de **integração** e **E2E**, os dois últimos contra **PostgreSQL real** (Testcontainers);
- **merge bloqueado** se qualquer verificação falhar (Branch Protection).

**Por que importa:** CI é a primeira linha de defesa contra regressões. Ele também é o que torna seguro trabalhar
em equipe: ninguém precisa "confiar" que o colega rodou os testes, porque o pipeline prova.

---

## 🧠 Conceitos

### CI × CD

| Sigla | Nome | O que faz | No TaskFlow |
|---|---|---|---|
| **CI** | Integração Contínua | Valida automaticamente cada mudança | ✅ |
| **CD** | Entrega Contínua | Deixa cada versão aprovada **pronta** para deploy | ❌ ainda não |
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
    subgraph Q [job: quality]
        direction TB
        q1[tsc --noEmit] --> q2[oxlint] --> q3[testes unitários] --> q4[nest build]
    end
    subgraph I [job: integration]
        i1["Testcontainers<br/>PostgreSQL real"]
    end
    subgraph X [job: e2e]
        x1["HTTP + PostgreSQL real"]
    end
    Q --> M{3 verdes?}
    I --> M
    X --> M
    M -->|sim| OK[merge liberado]
    M -->|não| NO[merge bloqueado]
```

**Por que três jobs, e não um:**

| | Um job sequencial | Três jobs paralelos |
|---|---|---|
| Feedback de um erro de lint | Espera os containers dos testes | Aparece em ~1 min no `quality` |
| Qual parte quebrou | Ler o log inteiro | O **nome** do job vermelho já diz |
| Tempo total | Soma de tudo | O tempo do job **mais lento** |
| Custo | 1 VM | 3 VMs (cada uma repete `npm ci` + `prisma generate`) |

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
      - run: npm run build

  integration:   # mesmo setup + npm run test:integration
  e2e:           # mesmo setup + npm run test:e2e
```

| Step | Por quê |
|---|---|
| `setup-node` com `cache: 'npm'` | Reaproveita o cache de pacotes entre execuções (instalação mais rápida) |
| `npx prisma generate` | Gera o client tipado; sem ele, nada que importe `@prisma/client` compila |
| `npx tsc --noEmit` | O `ts-jest` só **transpila**: erros de tipo passam nos testes e só o `tsc` pega |
| `npm run lint` | `oxlint --type-aware --deny-warnings`: regras que usam tipos, como `no-floating-promises` (Promise esquecida sem `await`) e `no-explicit-any`. Com `--deny-warnings`, um *warning* também falha o job: warning que não bloqueia vira ruído e se acumula |
| `npm run build` | Garante que o `nest build` (com o plugin do Swagger) funciona |

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

## 🔒 Branch Protection

Em **Settings → Branches → regra da `main`**:

```text
✅ Require a pull request before merging
✅ Require status checks to pass before merging
   Status checks obrigatórios:
     • Tipos, lint, unitários e build
     • Testes de integração (Testcontainers)
     • Testes E2E (Testcontainers)
✅ Require branches to be up to date before merging
✅ Do not allow bypassing the above settings
```

| Ação | Resultado |
|---|---|
| Push direto na `main` | ❌ Bloqueado (só via PR) |
| PR com qualquer job vermelho | ❌ Merge bloqueado |
| PR com os 3 jobs verdes | ✅ Merge liberado |

> ⚠️ **Armadilha ao renomear jobs:** o check obrigatório é identificado pelo **nome** do job. Quando o job único
> `Build & Test` virou três jobs, o check antigo **nunca mais reportaria**, e o PR ficaria travado em
> *"Expected — Waiting for status to be reported"*. Depois de renomear, rode o CI uma vez e atualize a lista de checks.

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
| 5 | Lint vermelho em scripts de estudo | Os scripts de laboratório em `test/load/` também passam pelo lint | Corrigidos no próprio PR (`fix(ci): corrige erros de lint…`) |
| 6 | Cada teste rodava **duas vezes** | `npm test` (todas as suítes) **e depois** cada suíte de novo | Um script por job; cada suíte roda uma vez |
| 7 | `--passWithNoTests` mascarava suíte vazia | A flag aprova até sem nenhum teste | Removida: suíte vazia falha |
| 8 | Hook de teste estourou 5 s sob carga | `testTimeout` dentro de `projects` é **ignorado** pelo Jest | `jest.setTimeout(60_000)` em [`setup-slow-suites.ts`](../../test/setup-slow-suites.ts), só para integração/E2E |
| 9 | Docker Desktop caiu rodando todas as suítes localmente | 4+ PostgreSQL de teste + stack de dev esgotaram a memória | `--runInBand` nas suítes com Testcontainers; o CI isola cada suíte numa VM |

---

## 📊 Resultados

| Momento | Execução | Resultado |
|---|---|---|
| Primeiro CI | Run #1 (setup inicial) | ❌ falhou em 36 s (Node 20 × Jest ESM) |
| | Run #2 (Node 24) | ✅ 37 s |
| Um job com unit + integração + E2E | Run #17 | ✅ 1 min 20 s |
| Três jobs paralelos | PRs #5 e #6 | ✅ todos verdes, com 150 testes por PR |

---

## 🚧 Limitações e próximos passos

- **CD não implementado:** não há deploy automático. O próximo passo natural é um workflow disparado no merge para a `main` que publica a imagem Docker e faz o deploy (ex.: Render/Fly.io + Neon).
- **Actions fixadas por tag** (`@v4`), e não por SHA: fixar por hash protege contra uma tag adulterada (*supply chain*).
- **Sem análise de dependências:** Dependabot, CodeQL e `npm audit` no CI cobririam o OWASP A06 (componentes vulneráveis).
- **Setup repetido nos 3 jobs:** uma *composite action* eliminaria as 6 linhas duplicadas.
- **Sem cobertura publicada:** o `test:cov` existe, mas o relatório não é exibido no PR.

---

## ✅ Checklist

- [x] Workflow em push e PR para a `main`
- [x] 3 jobs paralelos: qualidade, integração e E2E
- [x] Testes com PostgreSQL real no CI (Testcontainers)
- [x] `permissions` mínimas e cancelamento de runs obsoletos
- [x] Branch Protection exigindo os 3 checks
- [x] Badge do CI no README
- [ ] CD (deploy automatizado)
- [ ] Dependabot / CodeQL / actions fixadas por SHA

---

**Anterior:** [Módulo 01 — Observabilidade](01-observabilidade.md) ·
**Próximo:** [Módulo 04 — Modelagem NoSQL com DynamoDB](04-modelagem-nosql-dynamodb.md)
