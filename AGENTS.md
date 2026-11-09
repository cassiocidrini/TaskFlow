# AGENTS.md

> Contexto **neutro** para agentes de IA (Claude Code, Cursor, Codex, Copilot) e para pessoas novas no projeto.
> Leia antes de sugerir qualquer código, comando ou decisão arquitetural.
> É a **fonte da verdade** de contexto de IA (`CLAUDE.md` só aponta para cá). Trate como código:
> **se o código mudar e este arquivo não, ele passa a mentir** — atualize no mesmo PR.

## 📋 Visão geral

- **TaskFlow:** API de gestão de tarefas com **CQRS + Event Sourcing** (projeto de estudo e portfólio).
- **Domínio:** `User` → possui `Project`s → que contêm `Task`s. Tarefas são **event-sourced**; usuários e projetos são CRUD simples (de propósito: ES só onde o histórico importa).

| Camada | Tecnologia |
|---|---|
| Runtime / linguagem | Node.js 24 · TypeScript 6 (`strict`, `module: nodenext`) |
| Framework | NestJS 12 · `@nestjs/cqrs` · `@nestjs/config` · `@nestjs/swagger` |
| Dados | PostgreSQL 16 · Prisma 7 (driver adapter `@prisma/adapter-pg`) |
| Validação | `zod` (ambiente) · `class-validator` (DTOs) |
| Testes | Jest · Testcontainers · supertest · k6 (carga) |
| Observabilidade | OpenTelemetry → Jaeger + Prometheus · Grafana · logs JSON (`nestjs-pino`) |
| Infra | Docker Compose · Terraform (LocalStack) · GitHub Actions |

---

## 🚀 Comandos

```bash
# Desenvolvimento
npm run setup                           # clone novo → ambiente pronto (Linux, macOS e Windows)
npm run dev                             # infra:up + start:dev → http://localhost:3000 · Swagger em /docs
npm run infra:down                      # derruba os containers (infra:up:obs inclui Prometheus + Grafana)
npm run aws:up                          # LocalStack + Terraform (aws:down · aws:recreate · aws:resources)

# Qualidade — rodar SEMPRE antes de commitar
npx tsc --noEmit && npm run lint && npm run test:unit

# Testes com Docker (Testcontainers)
npm run test:integration                # ~1 min
npm run test:e2e                        # ~1,5 min
npm test                                # as 3 suítes em sequência

# Banco
npx prisma migrate dev --create-only --name <nome>   # gera o SQL SEM aplicar → REVISE → npx prisma migrate dev
npx prisma generate                                  # OBRIGATÓRIO após migrar (Prisma 7 não regenera sozinho)
```

> ⚠️ **Nunca** rodar `npx jest` direto: os scripts passam `--experimental-vm-modules` e `--runInBand`.

---

## 🏗️ Arquitetura

### Fluxo de escrita de uma tarefa (comando)

```text
Controller ─▶ CommandBus ─▶ Handler (1 linha) ─▶ TaskCommandRunner.run(target, mutate)
   1. ProjectsService.assertOwner(projectId, userId)       → 404 se o projeto não for do usuário
   2. TaskRepository.load(taskId)                          → reidrata o agregado dos eventos
      tarefa de OUTRO projeto                              → o MESMO 404 (anti-IDOR)
   3. mutate(task) → regra de domínio                      → TaskInvariantError vira 409
   4. TaskRepository.save(task) → appendMany atômico       → ConcurrencyConflictError (409)
   5. EventBus.publish(eventos gravados)                   → projeções atualizam tasks_read
```

- **Leitura:** listagens vêm do Read Model `tasks_read` (eventualmente consistente, paginado por cursor). O histórico (`GET …/history`) lê direto do Event Store.
- **Exceção:** `CreateTaskHandler` é anterior ao runner e faz o roteiro manualmente (`assertOwner` → `append(…, 0)` → `publish`).

### Onde fica cada coisa (`src/`)

| Caminho | Responsabilidade | Regra |
|---|---|---|
| `config/env.schema.ts` | Schema `zod` de TODAS as variáveis de ambiente | Variável nova entra aqui; ler via `ConfigService<Env, true>` |
| `app.setup.ts` | Helmet, CORS, `ValidationPipe`, Swagger | Usado pelo `main.ts` **e** pelo E2E — não duplicar config HTTP |
| `events/event-store.service.ts` | `append`/`appendMany` com `expectedVersion` e `{ actorId }`, `loadEvents` | Único ponto de escrita no Event Store; monta o envelope `metadata` (`eventId`, `actorId`, `correlationId`, `schemaVersion`) |
| `events/event-metadata.ts` | Tipo do envelope + `toEventMetadata` (zod, leitura) | Evento legado tem `metadata = {}`: campos opcionais na leitura, nunca inventados |
| `modules/tasks/domain/` | `TaskAggregate`, contrato `TaskRepository` | **Zero imports** de Nest, Prisma ou infra |
| `modules/tasks/infrastructure/` | `EventSourcedTaskRepository`, `toDomainEvent` | Único cast de leitura do Event Store vive aqui |
| `modules/tasks/commands/` | Commands, handlers, `TaskCommandRunner` | Handler de ciclo de vida = 1 linha via runner |
| `modules/tasks/events/` | Eventos de domínio + projeções (`@EventsHandler`) | Projeções **idempotentes** |
| `modules/projects/` | CRUD de projetos + `assertOwner` | Ponto único de autorização por projeto |
| `common/dto/pagination.dto.ts` | Paginação por cursor (`limit ≤ 100`) | Reusar em toda listagem |
| `common/correlation/` | `X-Correlation-Id` (1º middleware) + `AsyncLocalStorage` | Ler o id com `currentCorrelationId()`, nunca de parâmetro ou header |
| `common/telemetry/route-telemetry.guard.ts` | Preenche `http.route` (span e métrica); **1º `APP_GUARD`** | Não é controle de acesso (sempre `true`); grava o padrão da rota, nunca a URL |
| `health/` | `/health/live`, `/health/ready`, `ShutdownState` (drenagem) | Liveness **nunca** consulta dependências; readiness não expõe detalhe de infraestrutura |
| `common/lifecycle/` | Encerramento do OTel pelo ciclo de vida do Nest | `telemetry-registry.ts` não pode ter imports (é carregado pelo `tracing.ts`, antes de tudo) |
| `common/logging/logger.options.ts` | Opções do `nestjs-pino` (JSON, serializers, nível por status) | Serializers são **allowlist**: não adicione headers ao log |

**Fora de `src/`** (não entram no build nem na imagem de produção; o lint cobre todos):

| Caminho | Responsabilidade | Regra |
|---|---|---|
| `grafana/` | Datasources e dashboard **provisionados** (montados no compose) | Mudança de dashboard = editar o JSON + PR; métrica nova no painel entra em `KNOWN_METRICS` de `test/unit/grafana-dashboard.spec.ts`; nunca agrupar por label de alta cardinalidade |
| `scripts/` | Ferramentas de dev rodadas com `ts-node`: `list-events.ts`, `dynamo/` (lab do Módulo 4) | Script novo de dev entra aqui, **nunca** em `src/` |
| `load/k6/`, `load/autocannon/` | Testes de carga da API (Módulo 10) | Medem a API rodando; não são testes do Jest |
| `labs/node-internals/` | Experimentos do runtime (Módulo 11) | Arquivos gerados (`*.txt`, ~100 MB) são ignorados pelo Git |

### Padrões aplicados (e onde)

CQRS (`commands/` × `queries/`) · Event Sourcing (`TaskAggregate` + Event Store) · **Repository** (`TaskRepository` → `EventSourcedTaskRepository`) · Template Method funcional (`TaskCommandRunner`) · Strategy (`task-priority.strategy.ts`) · Observer (`EventBus` → projeções).
**Não existe** Factory no código — não referencie nem gere uma sem pedido explícito.

### Ordem crítica no `main.ts`

```typescript
import './env';      // 1º: carrega .env
import './tracing';  // 2º: OpenTelemetry ANTES de http/express/pg serem carregados
```

O `tracing.ts` também só pode importar arquivos sem dependências de biblioteca (hoje: `config/env.schema.ts`,
`common/lifecycle/telemetry-registry.ts` e `health/health-paths.ts`). Importar algo que puxe o `@nestjs/common` faria o Nest carregar antes do
`sdk.start()`.

---

## 🧩 Receitas

### Adicionar um evento novo ao ciclo de vida da tarefa (5 lugares)

1. `events/task.events.ts`: interface `XData` + classe `XEvent` (construtor com **objeto nomeado**) + entrada na união `TaskDomainEvent` + versão em `TASK_EVENT_SCHEMA_VERSIONS`.
2. `domain/task.aggregate.ts`: método de comando (valida invariantes → `raise`) + `case` no `apply()`.
3. `commands/task-command.runner.ts`: `case` no `toBusEvent()`.
4. `infrastructure/event-sourced-task.repository.ts`: tipo em `KNOWN_EVENT_TYPES`.
5. `events/task-lifecycle.projections.ts`: projeção idempotente (+ registrar no `tasks.module.ts`).

Os `switch` são exaustivos (`never`) e o `TASK_EVENT_SCHEMA_VERSIONS` é um `Record` exaustivo: esquecer a versão do passo 1 ou os passos 2 e 3 **não compila**. Os passos 4 e 5 só falham em runtime → cubra com teste.

Mudou o formato de um `XData` já gravado? Incremente a versão em `TASK_EVENT_SCHEMA_VERSIONS` e trate a versão antiga na leitura (*upcaster*): eventos gravados não são reescritos.

### Adicionar um comando de ciclo de vida

Command `(target: TaskCommandTarget, valor)` → handler de uma linha com `runner.run(target, (task) => task.metodo(valor))` → rota no `TasksController` com `UUID_V4` nos params e `userId` vindo de `@CurrentUser()`.

### Criar/alterar uma migração

1. `npx prisma migrate dev --create-only --name <nome>` e **leia o SQL**.
2. Mudança de **tipo** de coluna: o Prisma gera `DROP COLUMN` + `ADD COLUMN` (**perde dados**). Reescreva com `ALTER COLUMN … TYPE … USING …` (exemplo: `prisma/migrations/*_read_model_status_enum_completed_at`).
3. Coluna `NOT NULL` nova em tabela com dados: default ou *expand → backfill → contract*.
4. Índice em tabela grande: `CREATE INDEX CONCURRENTLY` (migração separada, fora de transação).
5. `npx prisma migrate dev` → `npx prisma generate`. Migração já aplicada em ambiente compartilhado é **imutável**.

---

## ⚠️ NÃO FAÇA

**Segurança**
- ❌ Ler `userId`/`ownerId` do body — sempre do JWT (`@CurrentUser()`).
- ❌ Rota de tarefa/projeto sem `JwtAuthGuard` (vai na **classe** do controller) ou sem `assertOwner`.
- ❌ Responder `403` para recurso de outro usuário — use `404` (anti-enumeration).
- ❌ Ler `process.env` fora de `env.schema.ts`/`tracing.ts`; usar `!` para silenciar variável ausente.
- ❌ Concatenar entrada do usuário em SQL; `origin: '*'` no CORS; logar senhas/tokens; expor `password`.
- ❌ Mensagens diferentes para "usuário não existe" e "senha errada".

**Event Sourcing**
- ❌ Alterar estado do agregado fora do `apply()`.
- ❌ Publicar no `EventBus` antes de gravar no Event Store (ordem: `assertOwner → save → publish`).
- ❌ `append` sem o `expectedVersion` lido do agregado.
- ❌ `actorId` vindo de outro lugar que não o `userId` do JWT do comando; preencher `actorId` de evento legado (`metadata = {}`) por inferência.
- ❌ Editar ou apagar linhas da tabela `events` (append-only; corrigir = novo evento).
- ❌ Projeção não idempotente (usar `createMany({ skipDuplicates })` / `updateMany`).
- ❌ Construtor de evento/command com vários parâmetros posicionais do mesmo tipo (já corrompeu o histórico uma vez: o banco de dev tem uma tarefa com título `"HIGH"`, prioridade passada na posição do título).

**Ciclo de vida**
- ❌ `process.exit()` ou `process.on('SIGTERM')` no código da app — o encerramento é do Nest (`enableShutdownHooks`); recurso que precisa fechar usa `onApplicationShutdown` (depois de o HTTP fechar), não `onModuleDestroy`.
- ❌ Liveness consultando banco ou outra dependência (reinício em massa quando a dependência cai).

**Código e testes**
- ❌ `any` sem justificativa; `console.log` em código de produção (use `Logger` do Nest: ele escreve pelo pino, em JSON, com `correlationId` e `trace_id`).
- ❌ Regra de negócio em controller.
- ❌ Importar `AppModule` estaticamente no topo de teste E2E — use `startE2EApp()` (`test/e2e/support/e2e-app.ts`).
- ❌ `sleep` fixo para esperar projeção em teste — use `eventually()`.
- ❌ `testTimeout` dentro de `projects` no `jest.config.ts` (é ignorado) — ver `test/setup-slow-suites.ts`.

**Processo**
- ❌ Push direto na `main` ou merge com CI vermelho (3 jobs obrigatórios).

---

## 🧪 Testes

| Suíte | Onde | Como |
|---|---|---|
| Unitários | `test/unit/` | Mocks; agregado testado **sem** mocks; timeout 5 s (lento = bug) |
| Integração | `test/integration/` | `startTestDatabase()` → Postgres real; contratos com o banco (constraints, `ON CONFLICT`) |
| E2E | `test/e2e/` | `startE2EApp()`, `registerAndLogin()`, `resetDatabase()`, `eventually()` |

- Suítes com Testcontainers rodam em fila (`--runInBand`): paralelismo esgota a RAM da máquina de dev.
- Teste novo de banco/consistência eventual: rode **3 vezes** antes de confiar.
- `ts-jest` só transpila: `npx tsc --noEmit` pega erros de tipo que os testes não pegam.

---

## 🚧 Ainda NÃO implementado (não assuma que existe)

metadata dos eventos no `EventBus`/projeções · *upcasters* de eventos · agregador de logs (Loki) · Transactional Outbox / replay de projeções · probes consumidos por orquestrador (manifesto Kubernetes, `HEALTHCHECK` no Dockerfile) · alertas (Grafana/Alertmanager) · Dockerfile em `node:24` e não-root · rate limit distribuído (Redis).

---

## 🎯 Checklist antes de propor código

- [ ] Autorização: guard na classe + `assertOwner` + `userId` do JWT?
- [ ] Entrada validada (DTO com `class-validator`, `UUID_V4` nos params)?
- [ ] Regra de negócio no agregado/service, não no controller?
- [ ] Teste unitário — e de integração/E2E se tocou banco ou HTTP?
- [ ] Migração revisada (sem `DROP COLUMN` acidental) + `prisma generate`?
- [ ] `npx tsc --noEmit`, `npm run lint` e `npm run test:unit` passando?
- [ ] README/AGENTS.md atualizados se o comportamento mudou?

**Você é responsável pelo código. IA é apoio, não substituto.**
