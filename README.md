# TaskFlow

[![CI](https://github.com/cassiocidrini/TaskFlow/actions/workflows/ci.yml/badge.svg)](https://github.com/cassiocidrini/TaskFlow/actions/workflows/ci.yml)

API REST para gestão de tarefas, desenvolvida em **NestJS + TypeScript**, com **observabilidade completa** (OpenTelemetry + Jaeger + Prometheus + Grafana) e **CI automatizado** com GitHub Actions.

---

## 🎯 Sobre o projeto

O TaskFlow é um projeto de estudo que simula uma aplicação backend real, cobrindo:

- **API REST** com NestJS e Prisma
- **Banco de dados** PostgreSQL
- **Observabilidade** com OpenTelemetry (traces e métricas)
- **CI/CD** com GitHub Actions
- **Infra local** com Docker Compose

O objetivo é servir como **laboratório prático** para estudar arquitetura, resiliência e observabilidade em aplicações modernas.

---

## 🏗️ Arquitetura
┌─────────────────┐
│ App NestJS │ ← instrumentada com OpenTelemetry
│ (TaskFlow) │
└────────┬────────┘
│
│ OTel SDK (auto-instrumentação)
│
┌────┴────┐
│ │
▼ ▼
┌────────┐ ┌──────────────┐
│ Jaeger │ │ Prometheus │ ← raspa a porta 9464
│(traces)│ │ (métricas) │
└────────┘ └──────┬───────┘
│
▼
┌─────────┐
│ Grafana │ ← dashboard com p50/p95/p99
└─────────┘


**Fluxo:**
1. Requisição HTTP chega no NestJS
2. A auto-instrumentação do OTel cria um **span**
3. O trace é enviado para o **Jaeger** (porta 4318)
4. As métricas são expostas em `/metrics` (porta 9464)
5. O **Prometheus** raspa esse endpoint a cada 5s
6. O **Grafana** consulta o Prometheus e monta o dashboard

---

## 🧰 Stack

| Camada | Ferramenta | Versão |
|--------|-----------|--------|
| Runtime | Node.js | 24 |
| Framework | NestJS | 12 |
| ORM | Prisma | 7 |
| Banco | PostgreSQL | 16 |
| Observabilidade | OpenTelemetry SDK | latest |
| Traces | Jaeger | latest |
| Métricas | Prometheus | latest |
| Dashboards | Grafana | latest |
| Containerização | Docker | 29 |
| CI | GitHub Actions | — |

---

## 🚀 Como rodar

### Pré-requisitos

- Node.js 24+
- Docker Desktop
- PowerShell (Windows) — os scripts são `.ps1`

### Primeira vez

```powershell
.\setup.ps1

O script:

Verifica pré-requisitos (Node, Docker)

Cria o .env a partir do .env.example (se não existir)

Instala dependências (npm install)

Sobe os containers (PostgreSQL, Jaeger, Prometheus, Grafana)

Aplica as migrações do Prisma

Desenvolvimento

.\dev.ps1

Sobe a aplicação em modo watch. Acesse http://localhost:3000.

Parar tudo

.\stop.ps1

Para os containers Docker.

🔍 Serviços disponíveis
Serviço	URL	Credenciais
App	http://localhost:3000	—
Jaeger (traces)	http://localhost:16686	—
Prometheus (métricas)	http://localhost:9090	—
Grafana (dashboards)	http://localhost:3001	admin / Teste@123
Métricas raw	http://localhost:9464/metrics	—
Dashboard no Grafana
Após rodar o .\dev.ps1, acesse o Grafana em http://localhost:3001 e importe o dashboard TaskFlow - Observabilidade (JSON está em dashboards/).

Para gerar tráfego e popular os gráficos:

1..100 | ForEach-Object { curl.exe -s http://localhost:3000 | Out-Null }

🧪 Testes

# Rodar todos os testes
npm test

# Verificação de tipos
npx tsc --noEmit

# Lint
npm run lint

# Build
npm run build

🔄 CI (Integração Contínua)
Cada push ou pull request para main dispara a pipeline de CI, que roda:

Checkout do código

Setup do Node.js 24

npm ci (instala dependências)

npx prisma generate (gera o Prisma Client)

npx tsc --noEmit (verifica tipos)

npm run lint (analisa código)

npm test (roda testes)

npm run build (compila a aplicação)

Status: https://github.com/cassiocidrini/TaskFlow/actions/workflows/ci.yml/badge.svg

📁 Estrutura

🔄 CI (Integração Contínua)
Cada push ou pull request para main dispara a pipeline de CI, que roda:

Checkout do código

Setup do Node.js 24

npm ci (instala dependências)

npx prisma generate (gera o Prisma Client)

npx tsc --noEmit (verifica tipos)

npm run lint (analisa código)

npm test (roda testes)

npm run build (compila a aplicação)

Status: https://github.com/cassiocidrini/TaskFlow/actions/workflows/ci.yml/badge.svg

📚 Documentação de estudo
Este projeto é parte de uma trilha de estudos para nível Pleno/Sênior. Os módulos estudados estão documentados em:

MODULO_1.md — Observabilidade Avançada

MODULO_3.md — CI/CD na Prática

📝 Licença
UNLICENSED — Projeto pessoal de estudo.