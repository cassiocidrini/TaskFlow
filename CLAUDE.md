# CLAUDE.md

> Arquivo de contexto para assistentes de IA (Claude Code, Cursor, Copilot, etc.).
> Leia este arquivo antes de sugerir qualquer código, comando ou decisão arquitetural.
> Trate-o como código: versionado, revisado e atualizado junto com o projeto.

---

## 📋 Visão Geral do Projeto

- **Nome:** TaskFlow
- **Propósito:** API REST para gestão de tarefas e projetos (projeto de estudo da trilha "Do Pleno ao Excelente")
- **Status:** Em desenvolvimento
- **Domínio:** Gestão de tarefas (users, projects, tasks)

### Stack Técnica

| Camada | Tecnologia | Versão |
|--------|-----------|--------|
| **Runtime** | Node.js | 24 |
| **Linguagem** | TypeScript | 6.x (strict) |
| **Framework** | NestJS | 12 |
| **ORM** | Prisma | 7.10 |
| **Banco** | PostgreSQL | 16 |
| **NoSQL** | DynamoDB (LocalStack) | — |
| **Observabilidade** | OpenTelemetry + Jaeger + Prometheus + Grafana | — |
| **Testes** | Jest + Testcontainers + supertest | — |
| **CI/CD** | GitHub Actions | — |
| **Containerização** | Docker + Docker Compose | — |

---

## 🚀 Comandos Mais Usados

### Desenvolvimento

```bash
# Setup completo (primeira vez ou após reiniciar o PC)
.\setup.ps1

# Iniciar em modo watch
.\dev.ps1
# OU
npm run start:dev

# Parar containers
.\stop.ps1
```

### Testes

```bash
npm run test:unit          # Unitários (rápidos, ~2s)
npm run test:integration   # Integração com Testcontainers (~70s, exige Docker)
npm run test:e2e           # E2E HTTP (~15s)
npm run test:cov           # Com cobertura
```

> ⚠️ **NUNCA rodar `npx jest` direto.** Sempre via npm scripts: eles passam a flag `--experimental-vm-modules`, necessária para ESM.

### Banco de Dados

```bash
npx prisma generate                        # Regerar Prisma Client
npx prisma migrate dev --name <nome>       # Nova migração
npx prisma migrate deploy                  # Aplicar migrações (produção/CI)
npx prisma studio                          # UI para explorar o banco
```

### Qualidade

```bash
npx tsc --noEmit           # Verificar tipos
npm run lint               # ESLint (oxlint)
npm run format             # Prettier
npm run build              # Compilar para dist/
```

### DynamoDB (estudo)

```bash
npm run dynamo:create      # Criar tabela
npm run dynamo:seed        # Popular dados
npm run dynamo:queries     # Rodar AP1, AP2, AP3
npm run dynamo:query-gsi   # Rodar AP4 (via GSI)
```

### Event Store

```bash
npm run events:list        # Listar todos os eventos
```

---

## 🏗️ Arquitetura

### Estilo Arquitetural

**Layered + CQRS + Event Sourcing**

- **Layered:** separação em `domain`, `application` e `infrastructure`
- **CQRS:** commands (escrita) separados de queries (leitura)
- **Event Sourcing:** eventos persistidos como fonte da verdade

### Diagrama

```
┌─────────────────────────────────────────────────────────────┐
│                         HTTP                                │
└──────────────────────────┬──────────────────────────────────┘
                           │
                    ┌──────┴──────┐
                    │ Controller  │
                    └──────┬──────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
       ┌─────────────┐           ┌─────────────┐
       │  CommandBus │           │  QueryBus   │
       └──────┬──────┘           └──────┬──────┘
              │                         │
              ▼                         ▼
       ┌─────────────┐           ┌─────────────┐
       │  Command    │           │   Query     │
       │  Handler    │           │   Handler   │
       └──────┬──────┘           └──────┬──────┘
              │                         │
              ▼                         │
       ┌─────────────┐                  │
       │ Event Store │                  │
       │ (append)    │                  │
       └──────┬──────┘                  │
              │ publica                 │
              ▼                         │
       ┌─────────────┐                  │
       │   Event     │  ─── projeta ───▶│
       │   Handler   │                  │
       └─────────────┘                  │
                                        ▼
                              ┌──────────────────┐
                              │   Read Model     │
                              │   (tasks_read)   │
                              └──────────────────┘
```

### Estrutura de Pastas

```
src/
├── common/                    # Código compartilhado (decorators, filters, guards)
│   ├── decorators/
│   ├── filters/
│   └── interceptors/
├── dynamo/                    # Scripts de estudo do Módulo 4 (NÃO é produção)
│   ├── client.ts
│   ├── model.ts
│   ├── createTable.ts
│   ├── seed.ts
│   └── queries.ts
├── events/                    # Event Store compartilhado
│   ├── event-store.service.ts
│   └── list-events.ts
├── modules/                   # Módulos de negócio
│   ├── auth/                  # Autenticação (bcrypt + JWT)
│   │   ├── dto/
│   │   ├── auth.controller.ts
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts
│   │   ├── jwt.strategy.ts
│   │   └── jwt-auth.guard.ts
│   └── tasks/                 # Módulo de tarefas (CQRS)
│       ├── commands/          # Escrita
│       │   ├── create-task.command.ts
│       │   └── create-task.handler.ts
│       ├── queries/           # Leitura
│       │   ├── get-tasks.query.ts
│       │   └── get-tasks.handler.ts
│       ├── events/            # Eventos de domínio
│       │   ├── task.events.ts
│       │   └── task-created.handler.ts
│       ├── dto/
│       ├── tasks.controller.ts
│       └── tasks.module.ts
├── prisma/                    # PrismaService + PrismaModule
│   ├── prisma.module.ts
│   └── prisma.service.ts
├── app.controller.ts
├── app.module.ts
├── app.service.ts
├── env.ts                     # Carrega .env (importar ANTES de tudo)
├── main.ts                    # Entry point
└── tracing.ts                 # OpenTelemetry (importar ANTES de tudo)

test/
├── setup.ts                   # Env vars para testes (DISABLE_THROTTLE=true)
├── unit/
│   ├── auth.service.spec.ts
│   └── create-task.handler.spec.ts
├── integration/
│   └── event-store.spec.ts
└── e2e/
    ├── auth.e2e-spec.ts
    └── tasks.e2e-spec.ts

prisma/
├── schema.prisma
└── migrations/
```

### Ordem CRÍTICA dos imports no `main.ts`

```typescript
import './env';         // 1º: carrega .env
import './tracing';     // 2º: inicializa OpenTelemetry
import { NestFactory } from '@nestjs/core';
// ... resto
```

Se trocar a ordem, o OTel não captura as primeiras requisições.

---

## 📐 Convenções de Código

### Nomenclatura

| Tipo | Convenção | Exemplo |
|------|-----------|---------|
| Arquivos | kebab-case | `create-task.handler.ts` |
| Classes | PascalCase | `CreateTaskHandler` |
| Interfaces | PascalCase (sem prefixo `I`) | `Task`, `TaskCreatedEvent` |
| Variáveis/funções | camelCase | `taskId`, `fetchTasks` |
| Constantes | UPPER_SNAKE_CASE | `MAX_ATTEMPTS`, `SALT_ROUNDS` |
| Tabelas (Prisma) | `@@map("snake_case")` | `@@map("tasks_read")` |
| Colunas (Prisma) | `@map("snake_case")` | `@map("created_at")` |

### Imports

- Ordem: nativos → externos → internos → relativos
- Relativos: sempre com caminho completo (`../../prisma/prisma.service`)
- Nunca: import circular
- Nunca: import com `.js` no final (ts-jest não resolve)

```typescript
// ✅ BOM
import { randomUUID } from 'crypto';                          // nativo
import { Injectable } from '@nestjs/common';                  // externo
import { PrismaService } from '../../prisma/prisma.service';  // interno

// ❌ RUIM
import { PrismaService } from './prisma/prisma.service.js';   // com .js
```

### Padrões de Código

- **Async/Await:** sempre (não usar `.then()`)
- **Try/Catch:** explícito em chamadas externas (HTTP, DB)
- **Tipos:** `unknown` em vez de `any` sempre que possível
- **Validação:** `class-validator` + DTOs em todos os endpoints
- **Logs:** estruturados em JSON com `correlationId` (ver seção de Observabilidade)
- **Correlation ID:** propagado entre camadas

### Estrutura de Testes (AAA)

```typescript
it('deve criar uma tarefa', async () => {
  // Arrange
  const command = new CreateTaskCommand('p1', 'Título');

  // Act
  const result = await handler.execute(command);

  // Assert
  expect(result).toBeDefined();
});
```

---

## ⚠️ NÃO FAÇA (regras críticas)

### Segurança

- ❌ Nunca colar dados de produção em prompts de IA
- ❌ Nunca commitar o arquivo `.env`
- ❌ Nunca concatenar strings em queries SQL (use `$1`, `$2` ou Prisma)
- ❌ Nunca usar `origin: '*'` em CORS
- ❌ Nunca logar senhas, tokens ou dados sensíveis
- ❌ Nunca expor `password` em respostas de API
- ❌ Nunca retornar mensagens diferentes para "usuário não existe" e "senha errada" (previne user enumeration)

### Código

- ❌ Nunca usar `any` sem justificativa explícita
- ❌ Nunca usar `console.log` em código de produção (use o logger estruturado)
  - Exceção: scripts de estudo (`src/dynamo/*.ts` e `src/events/list-events.ts`)
- ❌ Nunca commitar código sem rodar `npx tsc --noEmit`
- ❌ Nunca usar `SELECT *` em queries
- ❌ Nunca adicionar dependência sem checar `npm audit`

### Processo

- ❌ Nunca fazer push direto em `main` (use PR)
- ❌ Nunca fazer merge com CI vermelho
- ❌ Nunca aprovar PR que você não entendeu

---

## ✅ FAÇA SEMPRE

- ✅ Rodar `npm run test:unit` antes de commitar
- ✅ Rodar `npx tsc --noEmit` antes de PR
- ✅ Escrever testes para toda regra de negócio
- ✅ Usar `correlationId` em logs
- ✅ Usar `ON CONFLICT DO NOTHING` em operações idempotentes
- ✅ Usar `CREATE INDEX CONCURRENTLY` em tabelas grandes
- ✅ Documentar decisões arquiteturais com ADRs

---

## 🗄️ Modelagem de Dados (Prisma)

### Modelos Principais

```prisma
model User {
  id        String   @id @default(uuid())
  email     String   @unique
  name      String
  password  String   // SEMPRE hasheada com bcrypt
  tasks     Task[]
  createdAt DateTime @default(now()) @map("created_at")

  @@map("users")
}

model Project {
  id          String   @id @default(uuid())
  name        String
  description String?
  tasks       Task[]
  createdAt   DateTime @default(now()) @map("created_at")

  @@map("projects")
}

model Task {
  id          String     @id @default(uuid())
  title       String
  description String?
  status      TaskStatus @default(PENDING)
  projectId   String     @map("project_id")
  project     Project    @relation(fields: [projectId], references: [id])
  assigneeId  String?    @map("assignee_id")
  assignee    User?      @relation(fields: [assigneeId], references: [id])
  createdAt   DateTime   @default(now()) @map("created_at")
  updatedAt   DateTime   @updatedAt @map("updated_at")

  @@map("tasks")
}

model Event {
  id            String   @id @default(uuid())
  aggregateId   String   @map("aggregate_id")
  aggregateType String   @map("aggregate_type")
  eventType     String   @map("event_type")
  payload       Json
  version       Int
  createdAt     DateTime @default(now()) @map("created_at")

  @@index([aggregateId, version])
  @@map("events")
}

model TaskRead {
  id         String   @id @default(uuid())
  projectId  String   @map("project_id")
  title      String
  status     String   @default("PENDING")
  assigneeId String?  @map("assignee_id")
  createdAt  DateTime @default(now()) @map("created_at")
  updatedAt  DateTime @updatedAt @map("updated_at")

  @@index([projectId, createdAt])
  @@map("tasks_read")
}
```

### Regras de Modelagem

- Sempre usar `@@map` para ter nomes de tabela em snake_case no banco
- `@map` por campo, para colunas específicas
- `@@index` em campos usados em `WHERE` / `JOIN` / `ORDER BY`
- UUIDs como PK (`@default(uuid())`)

---

## 🔐 Segurança (OWASP Top 10)

### O que está implementado

| # | Proteção | Como |
|---|----------|------|
| A01 | Access Control | Guards + verificar ownership |
| A02 | Cryptographic Failures | bcrypt (custo 10), HTTPS em produção |
| A03 | Injection | Queries parametrizadas (Prisma + `$1`/`$2`) |
| A04 | Insecure Design | Rate limit (100/min global, 5/min login) |
| A05 | Misconfiguration | Helmet + CORS restrito |
| A07 | Auth Failures | JWT (1h) + anti user enumeration |

### Configuração Global (`main.ts`)

```typescript
app.use(helmet());
app.enableCors({
  origin: ['http://localhost:3001', 'https://taskflow.app'],
  credentials: true,
});
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,              // remove campos extras
  forbidNonWhitelisted: true,   // rejeita se vier campo desconhecido
  transform: true,
}));
```

### Guarda de Rotas

```typescript
@Get('me')
@UseGuards(JwtAuthGuard)         // rota protegida
me(@CurrentUser() user: { userId: string; email: string }) {
  return user;
}
```

### Rate Limit por Rota Sensível

```typescript
@Post('login')
@Throttle({ default: { limit: 5, ttl: 60_000 } })   // 5 tentativas/min
login(@Body() dto: LoginDto) { /* ... */ }
```

---

## 📊 Observabilidade

### Componentes

| Componente | Ferramenta | Porta | URL |
|------------|-----------|-------|-----|
| App | NestJS | 3000 | http://localhost:3000 |
| Métricas raw | OTel Prometheus Exporter | 9464 | http://localhost:9464/metrics |
| Traces | Jaeger | 16686 | http://localhost:16686 |
| Métricas | Prometheus | 9090 | http://localhost:9090 |
| Dashboards | Grafana | 3001 | http://localhost:3001 |

> As credenciais de desenvolvimento (PostgreSQL, Grafana) ficam no `.env` local e no `docker-compose.yml`.
> **Não** registre senhas neste arquivo. Use `.env.example` como referência dos nomes das variáveis.

### Padrão de Logs

Toda operação crítica deve logar em **JSON estruturado**, com `correlationId` propagado entre camadas.

- **Logger:** `pino` em produção
- **Níveis:** `debug` | `info` | `warn` | `error`
- **Proibido:** `console.log` (exceto nos scripts de estudo listados em "NÃO FAÇA")

**Campos obrigatórios** em toda operação crítica:

| Campo | Descrição |
|-------|-----------|
| `event` | Tipo do evento, no padrão `<entidade>.<acao>` |
| `correlationId` | Rastreio da requisição entre camadas |
| contexto do domínio | `taskId`, `projectId`, `userId`, conforme o caso |

**Eventos padronizados:** `task.created`, `task.updated`, `task.completed`, `auth.login.success`, `auth.login.failed`

**Nunca logar:** senha, token ou dados sensíveis (LGPD).

**Exemplo:**

```typescript
this.logger.info({
  event: 'task.created',
  correlationId,                 // recebido da requisição, não gerado aqui
  taskId: 'task-123',
  projectId: 'proj-456',
  assigneeId: 'user-789',
  message: 'Tarefa criada com sucesso',
});
```

### Métricas de Negócio (planejadas)

- `tasks_created_total`
- `tasks_completed_total`
- `auth_login_failed_total`
- `http_request_duration_ms` (histograma)
- `event_projection_lag` (atraso entre o append no Event Store e a atualização do `tasks_read`)

### Alerta Crítico (planejado)

- `event_projection_lag` alto por vários minutos indica que o read model está ficando para trás do Event Store.
- Por quê: o atraso cresce antes de o usuário perceber leituras desatualizadas, então o alerta é preventivo.

---

## 🧪 Estratégia de Testes

### Pirâmide

```
        ╱╲          E2E          (12 testes, ~15s): HTTP completo
       ╱──╲
      ╱    ╲        Integração   (8 testes, ~70s): Testcontainers
     ╱──────╲
    ╱        ╲      Unitários    (13 testes, ~2s): Mocks
   ╱──────────╲
```

### Tipos de Teste

| Tipo | Ferramenta | Quando usar |
|------|-----------|-------------|
| Unitário | Jest + mocks | Lógica isolada, regras de negócio |
| Integração | Jest + Testcontainers | Repositórios, Event Store |
| E2E | Jest + supertest | Fluxos HTTP completos |

### Regras

- Unitário: mocke só o que não é foco
- Integração: banco real (Postgres via Testcontainers)
- E2E: app NestJS completo + Postgres real
- Cobertura mínima: 70% em `src/modules/` (futuro)
- CI: roda os 3 tipos em paralelo

### Padrões Especiais

- **Throttler em testes:** desabilite via `DISABLE_THROTTLE=true` no `test/setup.ts`
- **JWT em testes:** use `JwtModule.registerAsync` (lê env na instanciação)
- **Import do `AppModule`:** estático no topo do teste (nunca `await import`)

---

## 🔄 CI/CD (GitHub Actions)

### Workflow Atual (`.github/workflows/ci.yml`)

Roda em `push` e `pull_request` para `main`:

1. Checkout
2. Setup Node 24 + cache npm
3. `npm ci`
4. `npx prisma generate`
5. `npx tsc --noEmit`
6. `npm run lint`
7. `npm test -- --passWithNoTests`
8. `npm run build`

### Branch Protection (recomendado)

- ✅ Require PR before merging
- ✅ Require status checks to pass (job "Build & Test")
- ✅ Do not allow bypassing

---

## 💼 Contexto de Negócio

- **Domínio:** gestão de tarefas e projetos
- **Usuários:** times pequenos (5-20 pessoas)
- **Volume esperado:** ~10k requisições/dia
- **Criticidade:** baixa (projeto de estudo)
- **LGPD:** aplicável se dados reais forem usados (evitar)

### Regras de Negócio

- Um usuário pode ser assignee de várias tarefas
- Uma tarefa pertence a um projeto
- Status possíveis: `PENDING`, `IN_PROGRESS`, `DONE`
- Eventos do domínio: `TaskCreated`, `TaskUpdated`, `TaskCompleted`
- Eventos são imutáveis e append-only

---

## 🎯 Checklist ao sugerir código

Antes de propor qualquer mudança, verifique:

- [ ] Respeita a arquitetura em camadas?
- [ ] Usa os padrões de código deste projeto?
- [ ] Tem tratamento de erro adequado?
- [ ] Tem testes? (se for regra de negócio)
- [ ] Tem validação de input? (se for endpoint)
- [ ] Tem log com `correlationId`? (se for operação crítica)
- [ ] Respeita as regras de segurança (OWASP)?
- [ ] Não usa `any` desnecessariamente?
- [ ] Roda `npx tsc --noEmit` sem erros?
- [ ] Passa no `npm run lint`?

---

## 📚 Documentação Adicional

- `MODULO_1.md`: Observabilidade (OTel + Jaeger + Prometheus + Grafana)
- `MODULO_3.md`: CI/CD (GitHub Actions)
- `MODULO_4.md`: DynamoDB (NoSQL)
- `MODULO_5.md`: Event Sourcing + CQRS
- `MODULO_6.md`: Segurança (OWASP Top 10)
- `MODULO_7.md`: Testes de verdade
- `README.md`: Visão geral do projeto

---

## 💡 Últimas Recomendações

### Quando estiver em dúvida

- Pergunte "Por que você sugere isso?" e não aceite cegamente
- Valide: rode os testes antes de commitar
- Teste local: o código gerado funciona?
- Revise: entendeu cada linha?

### Sinais de alerta

- 🚩 Código que "parece certo" mas tem bug sutil
- 🚩 APIs que não existem (alucinação)
- 🚩 Sugestões que quebram o padrão do projeto
- 🚩 Falta de tratamento de erro
- 🚩 Uso de `any` sem justificativa

**Você é o responsável final pelo código. IA é apoio, não substituto.**