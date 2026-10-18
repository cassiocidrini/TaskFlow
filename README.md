# TaskFlow

[![CI](https://github.com/cassiocidrini/TaskFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/cassiocidrini/TaskFlow/actions/workflows/ci.yml)

API REST de alta performance para gestão de tarefas, desenvolvida em **NestJS + TypeScript**, com arquitetura **CQRS + Event Sourcing**, **Observabilidade Completa**, **Segurança OWASP** e **Infraestrutura como Código (Terraform)**.

Este projeto é o resultado de uma trilha avançada de estudos focada em **Engenharia de Software Sênior**, simulando padrões e práticas adotados em ambientes corporativos de alta criticidade.

---

## 🏆 Destaques de Engenharia

- **Arquitetura Avançada:** CQRS (Command Query Responsibility Segregation) com Event Sourcing (fonte da verdade baseada em eventos imutáveis).
- **Design Patterns:** Aplicação de *Strategy*, *Factory*, *Observer* e *Repository*.
- **Observabilidade:** OpenTelemetry, Jaeger (traces), Prometheus (métricas) e Grafana (dashboards p50/p95/p99).
- **Qualidade e Testes:** Pirâmide de testes com Jest (Unitários), Testcontainers (Integração com PostgreSQL real) e Supertest (E2E).
- **Segurança:** OWASP Top 10 (Helmet, CORS, Rate Limit, JWT, bcrypt, ValidationPipe).
- **Infraestrutura como Código:** Provisionamento local via Docker Compose e AWS (S3, SQS, SNS, IAM) via **Terraform** com backend remoto.
- **Performance:** Load testing com k6 e análise de gargalos (Thread Pool, Event Loop, Memory Leaks).

---

## 🏗️ Arquitetura

O sistema usa uma combinação de **Layered Architecture** com **CQRS** e **Event Sourcing**.

```text
┌─────────────────────────────────────────────────────────────┐
│                         HTTP (REST)                         │
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
       │ (Postgres)  │                  │
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

**Fluxo de Observabilidade:**

1. Requisição HTTP chega no NestJS.
2. OTel SDK cria um span e envia para o Jaeger.
3. Métricas são expostas em `/metrics` e raspadas pelo Prometheus.
4. Grafana exibe dashboards em tempo real.

---

## 🧰 Stack Técnica

| Categoria | Tecnologia |
|---|---|
| Runtime & Framework | Node.js 24, NestJS 12 |
| Linguagem | TypeScript (strict) |
| Banco de Dados (Write) | PostgreSQL 16, Prisma 7 |
| Banco de Dados (NoSQL) | DynamoDB (via LocalStack) |
| Mensageria | SQS, SNS (via LocalStack) |
| Observabilidade | OpenTelemetry, Jaeger, Prometheus, Grafana |
| Segurança | Helmet, CORS, JWT, bcrypt, class-validator |
| Testes | Jest, Testcontainers, Supertest, k6 |
| Infraestrutura | Docker, Docker Compose, Terraform |
| CI/CD | GitHub Actions |

---

## 🚀 Como rodar o projeto

### Pré-requisitos

- Node.js 24+
- Docker Desktop (com WSL 2 ativado)
- Terraform (opcional, para o módulo de IaC)
- PowerShell (Windows) — os scripts são `.ps1`

### Primeira execução

```powershell
.\setup.ps1
```

O script instala dependências, sobe os containers (PostgreSQL, Jaeger, Prometheus, Grafana, LocalStack), gera o Prisma Client e aplica as migrações.

### Desenvolvimento

```powershell
.\dev.ps1
```

Acesse: <http://localhost:3000>

### Parar tudo

```powershell
.\stop.ps1
```

---

## 🔍 Serviços disponíveis (Local)

| Serviço | URL | Credenciais |
|---|---|---|
| App (API) | http://localhost:3000 | — |
| Jaeger (Traces) | http://localhost:16686 | — |
| Prometheus | http://localhost:9090 | — |
| Grafana | http://localhost:3001 | admin / Teste@123 |
| LocalStack (AWS) | http://localhost:4566 | test / test |

Para visualizar os dashboards, importe o JSON da pasta `dashboards/` no Grafana.

---

## 🧪 Testes e Qualidade

O projeto utiliza a pirâmide de testes completa:

```bash
# Testes Unitários (rápidos, com mocks)
npm run test:unit

# Testes de Integração (usam Testcontainers com PostgreSQL real)
npm run test:integration

# Testes End-to-End (HTTP com supertest)
npm run test:e2e

# Verificação de Tipos
npx tsc --noEmit

# Linter
npm run lint
```

---

## 🔄 CI/CD Pipeline

Cada `push` ou `pull_request` na branch `main` dispara o GitHub Actions, que executa em paralelo:

- **Build & Test:** `npm ci` → `prisma generate` → `tsc --noEmit` → `npm run lint` → `npm run test` → `npm run build`.

Se qualquer etapa falhar, o merge é bloqueado (Branch Protection configurada).

---

## 📁 Estrutura de Pastas

```text
├── src/
│   ├── common/          # Decorators, filters, interceptors
│   ├── events/          # Event Store compartilhado
│   ├── modules/         # Módulos de negócio
│   │   ├── auth/        # Autenticação (JWT + bcrypt)
│   │   └── tasks/       # CQRS (commands, queries, events, strategies)
│   └── prisma/          # Prisma Service e Module
├── test/
│   ├── unit/            # Testes unitários
│   ├── integration/     # Testes com Testcontainers
│   └── e2e/             # Testes HTTP com supertest
├── terraform/           # IaC (S3, SQS, SNS, IAM)
├── docker-compose.yml   # Infra local (Postgres, Jaeger, Prometheus, Grafana, LocalStack)
├── AGENTS.md            # Contexto para IAs (Claude, Cursor, Copilot)
└── CLAUDE.md            # Atalho para o AGENTS.md
```

---

## 📚 Documentação da Trilha de Estudos

Este repositório contém a documentação prática de uma trilha de 12 módulos de especialização backend.

- Módulo 1 — Observabilidade (OTel, Jaeger, Prometheus, Grafana)
- Módulo 3 — CI/CD com GitHub Actions
- Módulo 4 — Modelagem NoSQL com DynamoDB
- Módulo 5 — Event Sourcing, CQRS e Arquitetura
- Módulo 6 — Segurança e OWASP Top 10
- Módulo 7 — Testes de Verdade (Unit, Integration, E2E)
- Módulo 8 — Uso de IA no Desenvolvimento (AI-Assisted Engineering)
- Módulo 9 — Infraestrutura como Código com Terraform
- Módulo 10 — Performance e Load Testing com k6
- Módulo 11 — Node.js Internals (Event Loop, Threads, Streams, Leaks)
- Módulo 12 — Design Patterns (Strategy, Factory, Observer, Repository, Decorator)

---

## 📝 Licença

Este projeto está sob a licença **UNLICENSED**. Desenvolvido para fins de estudo e portfólio.