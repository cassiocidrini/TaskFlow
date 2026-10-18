# AGENTS.md

> Arquivo de contexto **neutro** para agentes de IA (Claude Code, Cursor, Codex, GitHub Copilot, etc.).
> Leia este arquivo antes de sugerir qualquer código, comando ou decisão arquitetural.
> Trate-o como código: versionado, revisado e atualizado junto com o projeto.
>
> Este arquivo é a **fonte da verdade** para contexto de IA. O `CLAUDE.md` é um espelho para compatibilidade com o Claude Code.

## 📋 Visão Geral do Projeto

- **Nome:** TaskFlow
- **Propósito:** API REST para gestão de tarefas e projetos (projeto de estudo da trilha "Do Pleno ao Excelente")
- **Status:** Em desenvolvimento
- **Domínio:** Gestão de tarefas (users, projects, tasks)

### Stack Técnica

| Camada | Tecnologia | Versão |
|---|---|---|
| **Runtime** | Node.js | 24 |
| **Linguagem** | TypeScript | 6.x (strict) |
| **Framework** | NestJS | 12 |
| **ORM** | Prisma | 7.10 |
| **Banco Relacional** | PostgreSQL | 16 |
| **Banco NoSQL** | DynamoDB (via LocalStack) | — |
| **Observabilidade** | OpenTelemetry + Jaeger + Prometheus + Grafana | — |
| **Testes** | Jest + Testcontainers + supertest + k6 (load) | — |
| **CI/CD** | GitHub Actions | — |
| **IaC** | Terraform (AWS: S3, SQS, SNS, IAM via LocalStack) | — |
| **Containerização** | Docker + Docker Compose | — |

---

## 🚀 Comandos Mais Usados

### Desenvolvimento

```powershell
.\setup.ps1        # Setup completo (instala deps, sobe containers, migra)
.\dev.ps1          # Inicia em modo watch
.\stop.ps1         # Para containers
```

### Desenvolvimento

```bash
npm run test:unit          # Unitários (rápidos, ~2s)
npm run test:integration   # Integração com Testcontainers (~70s, exige Docker)
npm run test:e2e           # E2E HTTP (~15s)
k6 run test/load/k6-smoke.js   # Load test simples
```

> ⚠️ **NUNCA** rodar `npx jest` direto. Sempre via npm scripts (necessário flag `--experimental-vm-modules`).

### Banco de Dados e Infraestrutura

```bash
npx prisma generate                        # Regerar Prisma Client
npx prisma migrate dev --name <nome>       # Nova migração
npx prisma studio                          # UI para explorar o banco

# Terraform (na pasta /terraform)
terraform init -reconfigure
terraform apply -auto-approve
```

### Qualidade

```bash
npx tsc --noEmit           # Verificar tipos
npm run lint               # ESLint (oxlint)
npm run build              # Compilar para dist/
```

---

## 🏗️ Arquitetura e Design Patterns

### Estilo Arquitetural

**Layered + CQRS + Event Sourcing**

- **Layered:** separação em `domain`, `application` e `infrastructure`.
- **CQRS:** commands (escrita) separados de queries (leitura).
- **Event Sourcing:** eventos persistidos na tabela `events` (fonte da verdade).

### Padrões de Projeto Aplicados (Design Patterns)

- **Strategy:** Usado para calcular a prioridade de uma tarefa (`KeywordPriorityStrategy`, `DeadlinePriorityStrategy`). O `CreateTaskHandler` injeta a estratégia e a utiliza.
- **Factory:** Usado para instanciar clientes HTTP de bancos diferentes (ex: `BankClientFactory`).
- **Observer:** Usado pelo `EventBus` do NestJS CQRS para notificar handlers que atualizam o Read Model.
- **Repository:** O `PrismaService` isola o acesso ao banco. A lógica de negócio não sabe se usamos Prisma, TypeORM ou SQL puro.
- **Decorator:** Usado pelo NestJS para adicionar comportamentos (ex: `@UseGuards(JwtAuthGuard)`, `@Throttle`).

### Node.js Internals (Regras Críticas)

- **NUNCA** usar `fs.readFileSync` para arquivos grandes. Use Streams (`fs.createReadStream` + `.pipe()`) para evitar estourar a memória (Memory Leak).
- **CPU-Bound:** Se sugerir código que faça cálculos pesados (ex: bcrypt, manipulação de imagens), lembre que o Node.js usa o Thread Pool (libuv). Operações síncronas bloqueiam o Event Loop.
- **Garbage Collector:** Evite variáveis globais que acumulam dados (como caches sem TTL). Use `lru-cache` se precisar de cache em memória.

### Estrutura de Pastas Principal

```text
src/
├── common/                    # Decorators, filters, interceptors
├── events/                    # Event Store compartilhado
├── modules/
│   ├── auth/                  # Autenticação (JWT + bcrypt)
│   └── tasks/                 # CQRS
│       ├── commands/          # Escrita
│       ├── queries/           # Leitura
│       ├── events/            # Eventos de domínio
│       └── strategies/        # Strategy Pattern (prioridade)
├── prisma/                    # PrismaService
├── env.ts                     # Carrega .env (importar ANTES de tudo)
└── tracing.ts                 # OpenTelemetry (importar ANTES de tudo)

test/
├── unit/                      # Testes unitários
├── integration/               # Testes com Testcontainers
├── e2e/                       # Testes HTTP
└── load/                      # Scripts do k6 (NÃO são testes do Jest)

terraform/                     # Infraestrutura como Código (AWS/LocalStack)
```

### Ordem CRÍTICA dos imports no `main.ts`

```typescript
import './env';         // 1º: carrega .env
import './tracing';     // 2º: inicializa OpenTelemetry
import { NestFactory } from '@nestjs/core';
```

Se trocar a ordem, o OTel não captura as primeiras requisições.

---

## 📐 Convenções de Código

### Nomenclatura e Imports

- **Arquivos:** kebab-case (`create-task.handler.ts`).
- **Classes:** PascalCase (`CreateTaskHandler`).
- **Tabelas (Prisma):** `@@map("snake_case")`.
- **Imports:** nativos → externos → internos → relativos (sem `.js` no final).

### Padrões de Código

- **Async/Await:** sempre (não usar `.then()`).
- **Tipos:** `unknown` em vez de `any` sempre que possível.
- **Validação:** `class-validator` + DTOs com `whitelist: true` e `forbidNonWhitelisted: true`.
- **Logs:** estruturados em JSON com `correlationId` (padrão `<entidade>.<acao>`, ex: `task.created`).

---

## ⚠️ NÃO FAÇA (Regras Críticas)

### Segurança (OWASP Top 10)

- ❌ Nunca commitar o arquivo `.env`.
- ❌ Nunca concatenar strings em queries SQL.
- ❌ Nunca usar `origin: '*'` em CORS.
- ❌ Nunca logar senhas, tokens ou dados sensíveis.
- ❌ Nunca expor `password` em respostas de API.
- ❌ Nunca retornar mensagens diferentes para "usuário não existe" e "senha errada".
- ❌ Nunca desabilitar o `ThrottlerGuard` em produção (só em testes via `DISABLE_THROTTLE=true`).

### Código e Arquitetura

- ❌ Nunca usar `fs.readFileSync` para arquivos grandes (usar Streams).
- ❌ Nunca usar `any` sem justificativa.
- ❌ Nunca usar `console.log` em produção (usar logger estruturado).
- ❌ Nunca colocar regras de negócio nos Controllers (delegar para Handlers/Services).
- ❌ Nunca commitar código sem rodar `npx tsc --noEmit` e `npm run lint`.

### Processo

- ❌ Nunca fazer push direto em `main` (usar PR).
- ❌ Nunca fazer merge com CI vermelho.

---

## ✅ FAÇA SEMPRE

- ✅ Rodar testes antes de commitar.
- ✅ Escrever testes unitários com Jest e de integração com Testcontainers.
- ✅ Usar `ON CONFLICT DO NOTHING` em operações idempotentes.
- ✅ Usar `CREATE INDEX CONCURRENTLY` em tabelas grandes.
- ✅ Usar `correlationId` nos logs.
- ✅ Se precisar de variáveis de ambiente no NestJS, usar `JwtModule.registerAsync` ou `ConfigModule`.

---

## 🗄️ Modelagem de Dados (Prisma)

- UUIDs como PK (`@default(uuid())`).
- `@@index` em campos usados em `WHERE` / `ORDER BY`.
- Event Store na tabela `events` (append-only, versionado).
- Read Model na tabela `tasks_read` (projeção desnormalizada).

---

## 🧪 Estratégia de Testes e Performance

### Pirâmide

- **Unitários:** Jest + mocks.
- **Integração:** Jest + Testcontainers (PostgreSQL real).
- **E2E:** Jest + supertest (HTTP real).

### Regras de Load Testing (k6)

- Use k6 para testes de carga (Módulo 10).
- Métricas essenciais: p95, throughput (req/s) e taxa de erro.
- Cuidado com o `UV_THREADPOOL_SIZE` ao testar endpoints CPU-bound (como bcrypt).
- Defina SLOs (ex: p95 < 500ms, taxa_erro < 1%) nos thresholds do k6.

---

## 🏗️ Infraestrutura e CI/CD

### GitHub Actions (`.github/workflows/ci.yml`)

Roda em push/PR para `main`: `npm ci` → `prisma generate` → `tsc` → `lint` → `test` → `build`.

### Terraform (`/terraform`)

- Recursos gerenciados: S3 Bucket, SQS Queue, SNS Topic, IAM Role/Policy.
- Backend remoto configurado no S3 (`use_lockfile = true`).
- Rodar `terraform plan` antes de `apply`.

---

## 📚 Documentação Adicional

- `MODULO_1.md` a `MODULO_12.md` (no repositório).
- `README.md`: Visão geral do projeto.

---

## 🎯 Checklist ao sugerir código

Antes de propor qualquer mudança, verifique:

- [ ] Respeita a arquitetura em camadas?
- [ ] Usa os padrões de código deste projeto?
- [ ] Tem tratamento de erro adequado?
- [ ] Tem testes (unitários/integração)?
- [ ] Tem validação de input?
- [ ] Tem log com `correlationId`?
- [ ] Respeita as regras de segurança (OWASP)?
- [ ] Não usa `any` desnecessariamente?
- [ ] Roda `npx tsc --noEmit` sem erros?
- [ ] Passa no `npm run lint`?
- [ ] Se for arquivo grande, usou Streams?
- [ ] Se for infraestrutura, usou Terraform?

**Você é o responsável final pelo código. IA é apoio, não substituto.**