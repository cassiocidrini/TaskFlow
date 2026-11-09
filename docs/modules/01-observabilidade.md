# Módulo 01 — Observabilidade (OpenTelemetry, Jaeger, Prometheus, Grafana)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 09/11/2026
>
> **Onde vive no código:** [`src/tracing.ts`](../../src/tracing.ts) · [`src/env.ts`](../../src/env.ts) ·
> [`src/main.ts`](../../src/main.ts) · [`src/common/logging/`](../../src/common/logging/logger.options.ts) ·
> [`src/common/correlation/`](../../src/common/correlation/correlation-id.middleware.ts) ·
> [`src/health/`](../../src/health/health.controller.ts) ·
> [`src/common/lifecycle/`](../../src/common/lifecycle/telemetry-shutdown.ts) ·
> [`docker-compose.yml`](../../docker-compose.yml) · [`prometheus.yml`](../../prometheus.yml)

---

## 🎯 Objetivo

Instrumentar a API **NestJS** com **OpenTelemetry (OTel)** para coletar **traces** e **métricas**, emitir **logs
estruturados em JSON** ligados aos traces por `trace_id` e por um `correlationId` de negócio, e visualizar tudo em
ferramentas de mercado:

| Ferramenta | Papel |
|---|---|
| **Jaeger** | Armazena e mostra traces (o caminho de cada requisição) |
| **Prometheus** | Armazena métricas como séries temporais |
| **Grafana** | Dashboards sobre o Prometheus (latência p50/p95/p99, taxa de requisições) |

**Por que importa:** sem observabilidade, um incidente em produção vira adivinhação. O OpenTelemetry é o padrão
aberto e *vendor-agnostic* do mercado: instrumenta-se uma vez e exporta-se para Jaeger, Datadog, New Relic,
Grafana Cloud ou AWS X-Ray, sem reescrever código.

---

## 🏗️ Arquitetura

```mermaid
flowchart LR
    APP["TaskFlow (NestJS)<br/>OTel SDK + auto-instrumentação"]
    APP -->|"OTLP/HTTP :4318<br/>(traces)"| J[Jaeger :16686]
    APP -->|"expõe /metrics<br/>na porta :9464"| M(( ))
    P[Prometheus :9090] -->|"scrape a cada 5s"| M
    G[Grafana :3001] -->|consulta PromQL| P
    APP -->|"logs JSON no stdout<br/>(correlationId + trace_id)"| L[[stdout]]
```

1. Uma requisição HTTP chega ao NestJS.
2. A **auto-instrumentação** cria *spans* automaticamente (HTTP, Express, consultas ao PostgreSQL).
3. O **`OTLPTraceExporter`** envia os traces ao Jaeger via OTLP/HTTP.
4. O **`PrometheusExporter`** expõe as métricas em `http://localhost:9464/metrics`. Esse servidor é **do OTel**, e não a porta 3000 da API.
5. O **Prometheus** coleta (*scrape*) esse endpoint a cada 5 s, e o **Grafana** monta os dashboards a partir dele.
6. Cada linha de log sai em **JSON no stdout** (`nestjs-pino`), com `correlationId`, `trace_id` e `span_id`. Quem
   coleta o stdout é a plataforma (Docker, Kubernetes, CloudWatch), não a aplicação (12-Factor, fator XI).

---

## 🧠 Conceitos

### Os três pilares

| Pilar | Responde | No TaskFlow |
|---|---|---|
| **Métricas** | *O quê* está acontecendo? (req/s, latência, erros) | ✅ Prometheus |
| **Traces** | *Onde* está o problema? (qual etapa da requisição demorou) | ✅ Jaeger |
| **Logs** | *Por quê* aconteceu? (detalhe de um evento específico) | ✅ JSON (`nestjs-pino`) com `correlationId`, `trace_id` e `span_id` em cada linha |

### Span, trace e contexto

- **Span:** uma unidade de trabalho com início e fim (ex.: "requisição HTTP", "query SQL").
- **Trace:** a árvore de spans de uma operação completa, que mostra o que chamou o quê e quanto tempo cada parte levou.
- **Propagação de contexto:** em sistemas distribuídos, o ID do trace viaja entre serviços em headers HTTP (`traceparent`), costurando um único trace através de vários processos.

### Resource e `service.name`

O *resource* descreve **quem** emite a telemetria. Sem `service.name`, o Jaeger lista o serviço como
`unknown_service:node` (problema nº 7 da tabela abaixo).

### Exporters

| Exporter | Modelo | Destino |
|---|---|---|
| `OTLPTraceExporter` | **push**: a app envia | Jaeger (`/v1/traces`) |
| `PrometheusExporter` | **pull**: o Prometheus vem buscar | `:9464/metrics` |

### Auto-instrumentação

`getNodeAutoInstrumentations()` aplica *patches* em bibliotecas conhecidas (`http`, `express`, `pg`…) **no momento
em que elas são carregadas**. Daí a regra mais importante deste módulo: **o tracing precisa ser inicializado antes
de qualquer outra importação**. Se o `express` ou o `pg` forem carregados primeiro, eles escapam da instrumentação.

### Logs estruturados (JSON)

Log em texto livre (`Tarefa criada para o projeto X`) só se pesquisa com regex. Em JSON, cada informação é um
**campo**, e o agregador (Loki, CloudWatch Logs Insights, Datadog) filtra e agrega por ele:
`level >= 50 and req.url like '/projects%'`. Uma linha por evento, sempre no stdout.

```json
{"level":30,"time":1794257381012,"correlationId":"demo-task-001",
 "req":{"method":"POST","url":"/projects/5b23…/tasks"},
 "trace_id":"9192a6fa8a9bdbb28c4ea32e902ccb2d","span_id":"2ea7d713c26e56b4","trace_flags":"01",
 "res":{"statusCode":201},"responseTime":10,"msg":"request completed"}
```

| Decisão | Por quê |
|---|---|
| **JSON por padrão**, `LOG_PRETTY=true` só em dev | O caminho padrão é o de produção. O pino-pretty é devDependency, e o schema de ambiente **recusa o boot** com `LOG_PRETTY=true` + `NODE_ENV=production` |
| **Serializers por allowlist** (método, url, status) | O log de acesso nunca contém headers: `Authorization` e cookies não vazam (OWASP A09). Allowlist vence uma lista de `redact`, porque um header sensível novo não precisa ser lembrado |
| **Nível pelo status**: 5xx = `error`, 4xx = `warn` | `level >= 50` mostra só falha nossa; 404 e 401 são erro do cliente e não devem acordar ninguém |
| **`bufferLogs` + `app.useLogger`** | Os logs do boot também saem em JSON, e todo `new Logger(...)` do Nest passa pelo pino **sem mudar nenhum call site** |
| **`trace_id` sem código** | A instrumentação do pino já vem no `getNodeAutoInstrumentations()` e injeta `trace_id`/`span_id` em toda linha emitida dentro de um span. Exige o pino carregado **depois** do `tracing` (a ordem do `main.ts` garante) |

### `correlationId` × `trace_id`

| | `trace_id` (OTel) | `correlationId` (`X-Correlation-Id`) |
|---|---|---|
| Quem cria | A infraestrutura de tracing | O cliente (front, app mobile) ou, na falta dele, a API |
| Natureza | Técnica: amostrável, some se um salto não propagar `traceparent` | De negócio: o app pode exibi-lo na tela de erro e o usuário cita no chamado |
| Onde aparece | Logs e Jaeger | Logs, header de resposta e atributo `correlation.id` no span |

Logar os dois liga o **chamado do suporte** ao **trace no Jaeger**. O `correlationId` também é gravado no envelope
de metadados de cada evento (`events.metadata`, ver [Módulo 05](05-event-sourcing-cqrs.md#o-envelope-de-metadados))
e aparece no histórico da tarefa: dá para ir do evento à requisição que o gerou. As mensagens de broker, outra
fronteira assíncrona onde o trace nem sempre é propagado, ainda não existem.

Como funciona no TaskFlow ([`correlation-id.middleware.ts`](../../src/common/correlation/correlation-id.middleware.ts)):

1. É o **primeiro** middleware (`configureApp()`), antes do Helmet e do log de acesso. Vale igual no E2E.
2. Aceita o header só se casar com `^[A-Za-z0-9._-]{1,64}$`. Ausente ou inválido → **gera um UUID e segue**
   (correlação é diagnóstico, nunca vira 400). A regex barra *log injection* (quebra de linha forjando outra
   linha de log) e ids de 10 KB repetidos em cada linha.
3. Devolve o id no header da resposta (inclusive em erros) e o expõe via CORS (`Access-Control-Expose-Headers`).
4. Roda o resto da requisição dentro de um **`AsyncLocalStorage`**
   ([`correlation-context.ts`](../../src/common/correlation/correlation-context.ts)): qualquer código chamado
   durante a requisição lê o id com `currentCorrelationId()`, sem parâmetro, e duas requisições simultâneas nunca
   veem o id uma da outra.
5. O `pino-http` usa esse mesmo id como id da requisição, gravado com o nome `correlationId`.

**Por que um ALS próprio, e não o do `nestjs-pino`:** o de lá guarda o *logger* e só existe numa requisição HTTP.
O id também será lido por código sem HTTP (gravação de eventos, worker, consumers), que não deve depender da
biblioteca de log.

### Percentis: p50, p95, p99

| Percentil | Significado |
|---|---|
| **p50** (mediana) | Metade das requisições é mais rápida que isso |
| **p95** | 95% são mais rápidas; 1 em cada 20 usuários espera mais |
| **p99** | 99% são mais rápidas; é a "cauda" da distribuição |

**A média mente:** se 99 requisições levam 5 ms e 1 leva 5 s, a média é ~55 ms (parece ótimo), mas o p99 é 5 s.
É por isso que SLOs são definidos em percentis (ex.: *p95 < 500 ms*) e não em médias.

---

## 📋 Como reproduzir (estado atual do projeto)

### 1. Dependências

```bash
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-proto @opentelemetry/exporter-prometheus \
  @opentelemetry/sdk-metrics @opentelemetry/resources @opentelemetry/semantic-conventions

# Logs JSON (o @opentelemetry/api é usado direto pelo middleware de correlação)
npm install nestjs-pino pino pino-http @opentelemetry/api
npm install -D pino-pretty
```

### 2. Infraestrutura local

Os serviços estão no [`docker-compose.yml`](../../docker-compose.yml):

| Serviço | Portas | Observação |
|---|---|---|
| `jaeger` (all-in-one) | `16686` UI · `4318` OTLP/HTTP · `4317` OTLP/gRPC | `COLLECTOR_OTLP_ENABLED=true` |
| `prometheus` | `9090` | Lê o [`prometheus.yml`](../../prometheus.yml) |
| `grafana` | `3001` → 3000 | Porta 3001 para não colidir com a API · `admin` / `admin` |

```yaml
# prometheus.yml — o Prometheus roda num container e "olha para fora" para achar a app
scrape_configs:
  - job_name: 'taskflow'
    static_configs:
      - targets: ['host.docker.internal:9464']
```

```bash
docker compose up -d postgres jaeger prometheus grafana
```

> `host.docker.internal` é o nome da máquina hospedeira visto de dentro do container. É assim que o
> Prometheus enxerga a app rodando **fora** do Docker (`npm run start:dev`).
>
> O Docker Desktop (macOS/Windows) cria esse nome sozinho; o **Docker Engine do Linux não**. Sem ajuda, o
> alvo fica `down` com `lookup host.docker.internal: no such host`. Por isso o serviço `prometheus` declara:
>
> ```yaml
> extra_hosts:
>   - "host.docker.internal:host-gateway"   # host-gateway = IP do host na rede bridge do Docker
> ```
>
> Alternativas descartadas: `network_mode: host` (não funciona igual no Docker Desktop e tira o container da
> rede do compose) e IP fixo como `172.17.0.1` (depende da sub-rede configurada em cada máquina).
> Com firewall ativo no Linux (`ufw`), pode ser preciso liberar a porta `9464` vinda da bridge do Docker.

### 3. `src/tracing.ts`

```ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { envSchema } from './config/env.schema';

// O tracing sobe ANTES do Nest, então ainda não existe ConfigService.
// Reaproveitamos o MESMO schema zod para validar só este campo (mesma regra, mesmo default).
const otlpEndpoint = envSchema.shape.OTEL_EXPORTER_OTLP_ENDPOINT.parse(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'taskflow' }),
  traceExporter: new OTLPTraceExporter({ url: `${otlpEndpoint}/v1/traces` }),
  metricReader: new PrometheusExporter({ port: 9464, host: '0.0.0.0' }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

// Sem handler de SIGTERM aqui: o encerramento do SDK é o último passo do graceful shutdown do Nest
registerTelemetryShutdown(() => sdk.shutdown());
```

O endpoint do Jaeger vem da variável **`OTEL_EXPORTER_OTLP_ENDPOINT`** (default `http://localhost:4318`), validada
pelo schema de ambiente do projeto ([`env.schema.ts`](../../src/config/env.schema.ts)). Dentro de um container,
`localhost` não é o Jaeger, e por isso o endereço **não pode** ficar fixo no código.

### 4. A ordem dos imports no `src/main.ts`

```ts
import './env';      // 1º: carrega o .env (dotenv)
import './tracing';  // 2º: OTel instrumenta http/express/pg ANTES de eles serem carregados
import { NestFactory } from '@nestjs/core';
// ...
```

Trocar a ordem não quebra nada visivelmente: a app sobe normalmente, mas **parte dos spans simplesmente não
aparece**. É o tipo de bug silencioso que justifica um comentário no código e uma regra no
[`AGENTS.md`](../../AGENTS.md).

### 5. Rodar e gerar tráfego

```bash
cp .env.example .env       # Windows: copy .env.example .env
npm ci && npx prisma generate && npx prisma migrate deploy
npm run start:dev
```

```bash
# 100 requisições
for i in $(seq 1 100); do curl -s -o /dev/null http://localhost:3000; done
```

### 6. Logs e correlação

| Variável | Default | Uso |
|---|---|---|
| `LOG_LEVEL` | `info` | `fatal` · `error` · `warn` · `info` · `debug` · `trace` · `silent` (os E2E usam `silent`) |
| `LOG_PRETTY` | `false` | `true` = legível no terminal (o `.env.example` liga em dev). Proibido com `NODE_ENV=production` |

```bash
# Com LOG_PRETTY=false para ver o JSON cru:
curl -i -H 'X-Correlation-Id: chamado-1234' http://localhost:3000   # a resposta traz X-Correlation-Id: chamado-1234
curl -i -H 'X-Correlation-Id: a b<script>' http://localhost:3000   # inválido → a resposta traz um UUID novo
```

Do log ao trace: copie o `trace_id` da linha e abra `http://localhost:16686/trace/<trace_id>`. Do chamado ao
trace: no Jaeger, *Search* → *Tags* `correlation.id=chamado-1234`.

> O atributo `correlation.id` fica no span `middleware - correlationIdMiddleware` (é o span ativo quando o
> middleware roda), não no span raiz do HTTP. A busca por tag encontra o trace inteiro do mesmo jeito.

### 7. Onde olhar

| Ferramenta | URL | O que ver |
|---|---|---|
| Jaeger | http://localhost:16686 | *Service:* `taskflow` → *Find Traces* → abrir um trace e ver os spans |
| Logs | terminal do `npm run start:dev` | Uma linha JSON por evento; `correlationId` e `trace_id` em cada uma |
| Métricas cruas | http://localhost:9464/metrics | O texto que o Prometheus coleta |
| Prometheus | http://localhost:9090/targets | Target `taskflow` deve estar **UP** |
| Grafana | http://localhost:3001 (`admin` / `admin`) | Dashboard com p50/p95/p99 |

Consulta PromQL do **p95** usada no painel de latência:

```promql
histogram_quantile(0.95, sum by (le) (rate(http_server_request_duration_bucket[1m])))
```

---

## 🩺 Operação: health checks e graceful shutdown

Observabilidade responde "o que está acontecendo". Um orquestrador (Kubernetes, ECS, um load balancer) precisa
de duas respostas mais simples, a cada poucos segundos: **reinicio esta réplica?** e **mando tráfego para ela?**
E, quando ela vai sair (deploy, *scale-in*), de um encerramento que não derrube requisições.

### Liveness × readiness

| Rota | Pergunta | Verifica | Falha significa |
|---|---|---|---|
| `GET /health/live` | O processo está vivo? | Nada externo | O orquestrador **reinicia** o container |
| `GET /health/ready` | Posso receber tráfego agora? | `SELECT 1` no Postgres (até 1 s) + "não estou encerrando" | A réplica **sai do balanceador**, mas continua viva |

**Por que o liveness não olha o banco:** com o Postgres fora do ar, todas as réplicas falhariam o liveness ao mesmo
tempo e seriam reiniciadas em massa (*restart storm*). Reiniciar a API não conserta o banco, e o tráfego de boot
de todas as réplicas juntas ainda pesa no banco quando ele voltar. O readiness tira as réplicas da rotação e
as devolve sozinho quando o banco volta.

Outras decisões ([`health.controller.ts`](../../src/health/health.controller.ts)):

- **Públicos, sem JWT:** probe não autentica. O guard fica nos controllers de negócio, não global.
- **`@SkipThrottle()`:** o probe não pode tomar 429.
- **Fora do log de acesso:** um probe a cada 5 s daria ~17 mil linhas/dia por réplica sem informação. A falha
  continua no log (warn do indicador + erro do terminus em JSON).
- **Sem detalhe de infraestrutura na resposta:** o indicador próprio ([`database.health.ts`](../../src/health/database.health.ts))
  devolve só `up`/`down`. O `PrismaHealthIndicator` pronto do terminus devolveria a mensagem crua do driver
  (`connect ECONNREFUSED 10.0.3.7:5432`) numa rota pública (OWASP A05).
- **Timeout de 1 s:** um banco que *trava* é pior que um que recusa. Sem timeout, o probe ficaria pendurado.

```bash
curl -s localhost:3000/health/live    # {"status":"ok","info":{},"error":{},"details":{}}
curl -s localhost:3000/health/ready   # {"status":"ok","info":{"shutdown":{"status":"up"},"database":{"status":"up"}},…}
```

### A sequência do graceful shutdown

`app.enableShutdownHooks(['SIGTERM', 'SIGINT'])` faz o Nest rodar `app.close()` no sinal. A ordem do `close()`
está no código do Nest (`nest-application-context.js`): `onModuleDestroy` → `beforeApplicationShutdown` →
fecha o HTTP → `onApplicationShutdown`. O TaskFlow encaixa cada passo onde ele faz sentido:

```text
SIGTERM
 1. onModuleDestroy            (nada)
 2. beforeApplicationShutdown  ShutdownState: draining = true → /health/ready = 503, respostas com Connection: close
                               espera SHUTDOWN_DRAIN_MS, ainda atendendo normalmente
 3. HTTP fecha                 para de aceitar conexões e ESPERA as requisições em andamento
 4. onApplicationShutdown      Prisma desconecta → OpenTelemetry envia os spans finais
    (watchdog: se tudo isso passar de SHUTDOWN_TIMEOUT_MS, saída forçada com código 1 e log do motivo)
```

| Peça | Por quê |
|---|---|
| **Drenagem** (`SHUTDOWN_DRAIN_MS`, 0 em dev; ~5000 em Kubernetes) | O SIGTERM e a remoção do pod dos endpoints do Service acontecem **em paralelo**. Sem a janela, requisições roteadas nesse meio-tempo encontram o servidor fechado. A opção `gracefulShutdownTimeoutMs` do terminus só espera; ela não faz o readiness falhar |
| **`Connection: close` durante a drenagem** ([`draining-connection.middleware.ts`](../../src/health/draining-connection.middleware.ts)) | Proxies (ALB, nginx) mantêm um *pool* keep-alive com a réplica. O header faz o proxy descartar essas conexões em vez de reutilizá-las até o fechamento |
| **Prisma no `onApplicationShutdown`** (antes: `onModuleDestroy`) | Ver o problema 14: desconectar antes de o HTTP fechar deixava uma conexão órfã |
| **OTel pelo ciclo de vida do Nest** ([`telemetry-shutdown.ts`](../../src/common/lifecycle/telemetry-shutdown.ts)) | Antes, o `tracing.ts` tinha o próprio `process.on('SIGTERM')` com `process.exit(0)`: saía sem esperar o Nest. Agora o `tracing.ts` só **registra** `sdk.shutdown` num arquivo sem imports ([`telemetry-registry.ts`](../../src/common/lifecycle/telemetry-registry.ts)), para não carregar o `@nestjs/common` antes do `sdk.start()` |
| **Watchdog** (`SHUTDOWN_TIMEOUT_MS`, 8 s) | Abaixo dos 10 s do `docker stop`: a app sai sozinha, com log do motivo, em vez de levar `SIGKILL` em silêncio. O schema exige `DRAIN < TIMEOUT` |

### Prova: SIGTERM sob carga

Script com 20 conexões keep-alive em `GET /projects` (rota que consulta o banco), SIGTERM aos 2 s, drenagem de
2 s, polling do `/health/ready` a cada 100 ms. Cada requisição foi classificada como OK, **cortada** (`ECONNRESET`
ou 5xx: estava em andamento e morreu) ou **recusada** (`ECONNREFUSED`: chegou depois de o servidor fechar).

| Cliente | OK | Cortadas | Recusadas | Readiness |
|---|---:|---:|---:|---|
| **Como um balanceador** (para de mandar tráfego ao ver 503) | 2.872 | **0** | **0** | 200 → **503 no SIGTERM** (t=2,0 s) → fechado 2 s depois (t=4,1 s) |
| Cru (ignora o readiness e insiste na réplica) | 5.874 | 17 | 1.908 | idem |

Com um cliente que respeita o readiness, o encerramento é limpo. As 17 cortadas do cliente cru são conexões
abertas no instante do `close()`, que o Node fecha como ociosas porque ainda não tinham uma requisição lida. É o
tráfego que a drenagem existe para desviar, e nenhum balanceador o mandaria. O processo terminou com
**exit 143** (SIGTERM tratado), com os logs na ordem `ShutdownState` → `Telemetry`.

---

## ⚠️ Problemas encontrados e soluções

Problemas **reais**, na ordem em que apareceram:

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | Prisma 8 (RC) instalado por padrão | Versão pré-lançamento com comandos novos | Fixar `prisma@7` |
| 2 | `migrate dev` não reconhecido | O Prisma 8 renomeou comandos | Voltar para o 7 |
| 3 | `url` não aceito no `schema.prisma` | O Prisma 7 moveu a URL para o `prisma.config.ts` | Criar o `prisma.config.ts` |
| 4 | `PrismaClient` "não exportado" no editor | O servidor TypeScript do VS Code ficou com tipos antigos | `F1` → *TypeScript: Restart TS Server* |
| 5 | Erros de compilação com arquivos fora de `src/` | `prisma.service.ts` estava em `prisma/` | Mover para `src/prisma/` (tudo sob o `rootDir`) |
| 6 | Nest não sobe: `DATABASE_URL` undefined | `.env` não carregado | `src/env.ts` com `import 'dotenv/config'`, importado primeiro |
| 7 | Jaeger mostra `unknown_service:node` | Faltava o `service.name` no resource | `resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'taskflow' })` |
| 8 | Painel do Grafana com "No data" | Nome de métrica errado na consulta | Usar `http_server_request_duration_bucket` |
| 9 | Porta 3000 em conflito (API × Grafana) | Os dois usavam a 3000 | Grafana exposto na 3001 |
| 10 | Fluxo de criação de dashboard confuso no Grafana 12 | A UI mudou | Importar o dashboard via JSON |
| 11 | Tipos do Prisma desatualizados depois de uma migração | No Prisma 7, o `migrate dev` **não** roda mais o `prisma generate` | Sempre `npx prisma migrate dev` → `npx prisma generate` |
| 12 | No Linux, alvo `taskflow` `down` no Prometheus (`lookup host.docker.internal: no such host`) | Só o Docker Desktop cria `host.docker.internal`; o Docker Engine não | `extra_hosts: host.docker.internal:host-gateway` no serviço `prometheus` (ver item 2) |
| 13 | Ao testar os logs, a API nova falhou com `EADDRINUSE :3000` (o erro, ao menos, já saiu em JSON) | Encerrar o `nest start --watch` com `pkill` deixou o processo filho `node dist/main` órfão, segurando a porta | Matar o órfão (`ss -ltnp \| grep 3000`). A causa de fundo, sinais de encerramento sem tratamento, é assunto do graceful shutdown |
| 14 | O Prisma desconectava **antes** de o HTTP fechar | `$disconnect` no `onModuleDestroy`, o 1º passo do `app.close()` | Mover para o `onApplicationShutdown`. A hipótese inicial ("a requisição em andamento falha com 500") estava **errada**: o teste passou na ordem antiga, porque o Prisma reconecta sozinho. O efeito real, medido no `pg_stat_activity`: a query tardia **reabria** o pool e deixava **1 conexão** aberta até o processo morrer (0 na ordem nova). O teste `graceful-shutdown.spec.ts` falha na ordem antiga |
| 15 | No primeiro teste de SIGTERM sob carga, 20 requisições "cortadas" | O script batia direto na réplica ignorando o readiness: conexões abertas no instante do `close()` levam reset | Medir com um cliente que se comporta como balanceador (0 cortadas). O `Connection: close` na drenagem cuida dos pools keep-alive de proxies |

---

## 📊 Resultados obtidos

Medição com **100 requisições** a `GET /` (versão inicial do projeto, máquina local):

| Latência HTTP | Média | Máxima | Última |
|---|---:|---:|---:|
| **p50** | 4,71 ms | 6,21 ms | 2,69 ms |
| **p95** | 12,0 ms | 17,6 ms | 6,54 ms |
| **p99** | 19,2 ms | 23,5 ms | 9,31 ms |

| Taxa de requisições | |
|---|---:|
| Pico | 3,84 req/s |
| Média | 0,499 req/s |

O Jaeger registrou **20 traces**, com duração entre **1,93 ms** e **9,28 ms**. Repare como o **p99 (19,2 ms) é
quatro vezes o p50 (4,71 ms)** mesmo num endpoint trivial: é a cauda que a média esconderia.

---

## 🔄 Como este módulo evoluiu com o projeto

A primeira versão funcionava, mas tinha atalhos que os blocos de correção seguintes eliminaram:

| Primeira versão | Hoje | Por quê |
|---|---|---|
| Endpoint do Jaeger fixo no código | `OTEL_EXPORTER_OTLP_ENDPOINT`, validado com `zod` | Configuração pertence ao ambiente (12-Factor); em container, `localhost` é outro lugar |
| `process.env.DATABASE_URL!` no `PrismaService` | `ConfigService<Env, true>` | O `!` só calava o compilador; agora a app **recusa subir** se o valor faltar |
| `.env` com uma variável | [`.env.example`](../../.env.example) completo e documentado | Um clone novo sobe com `cp .env.example .env` |
| `console.log` no `main.ts` | `Logger` do Nest | Primeiro passo rumo a logs estruturados |
| `Logger` do Nest em texto colorido | JSON via `nestjs-pino`, com `correlationId`, `trace_id` e `span_id` | Logs pesquisáveis por campo e ligados ao trace; os call sites do `Logger` não mudaram |
| `X-Correlation-Id` só listado no CORS (ninguém lia nem devolvia) | Middleware que valida, gera, devolve, expõe via CORS e propaga por `AsyncLocalStorage` | O cliente sempre tem um id para citar; o código lê o id sem recebê-lo por parâmetro |
| Sem health check; `process.exit(0)` no SIGTERM do `tracing.ts` | `/health/live` + `/health/ready` e graceful shutdown pelo ciclo de vida do Nest | O orquestrador sabe quando reiniciar e quando tirar a réplica do balanceador; deploy sem cortar requisições |

---

## 🚧 Limitações e próximos passos

- **Probes ainda sem consumidor:** não há manifesto Kubernetes nem `HEALTHCHECK` no Dockerfile. Os probes existem e foram testados, mas nada os chama automaticamente (Módulo 02 e a troca do Dockerfile para `node:24` não-root).
- **Coleta de logs:** os logs saem em JSON no stdout, mas nenhum agregador os coleta localmente (ex.: Loki + Promtail no compose). Hoje se lê com `docker logs`/terminal.
- **`correlationId` fora do HTTP:** um log emitido fora de uma requisição (boot, script) sai sem `correlationId`, e um evento gravado fora dela fica sem o campo no envelope.
- **Dashboards como código:** o dashboard do Grafana foi importado manualmente. O ideal é provisioná-lo por arquivo (`grafana/provisioning/`), para que suba pronto com o `docker compose up`.
- **Jaeger v1:** as imagens do compose têm versão fixa (nunca `:latest`, para o ambiente de amanhã ser igual ao de hoje), mas o `jaegertracing/all-in-one:1.76.0` é a última linha do **v1**, já descontinuado. O próximo passo é migrar para o Jaeger v2 (`jaegertracing/jaeger`), que é construído sobre o OpenTelemetry Collector.
- **Amostragem (*sampling*):** hoje 100% das requisições geram trace. Em produção com alto volume, amostra-se (ex.: 10%, ou 100% só das que têm erro) para controlar custo.

---

## ✅ Checklist

- [x] OpenTelemetry SDK com auto-instrumentação, inicializado **antes** do Nest
- [x] `service.name = taskflow` visível no Jaeger
- [x] Endpoint OTLP configurável por variável de ambiente (validada)
- [x] Métricas expostas em `:9464/metrics` e coletadas pelo Prometheus
- [x] Dashboard no Grafana com p50/p95/p99 e taxa de requisições
- [x] Logs estruturados em JSON com `trace_id`, `span_id` e `correlationId`
- [x] `X-Correlation-Id` validado, gerado, devolvido e propagado por `AsyncLocalStorage`
- [x] Liveness e readiness separados, sem vazar detalhes de infraestrutura
- [x] Graceful shutdown: drenagem com readiness 503, HTTP antes do banco, OTel por último, watchdog
- [ ] Dashboards provisionados por arquivo

---

**Próximo:** [Módulo 03 — CI/CD com GitHub Actions](03-ci-cd-github-actions.md) ·
O Módulo 02 (Kubernetes) está planejado para um ambiente Linux dedicado.
