# Módulo 10 — Performance e Load Testing (k6)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** [`test/load/k6-smoke.js`](../../test/load/k6-smoke.js) ·
> [`test/load/k6-register.js`](../../test/load/k6-register.js) · scripts com autocannon em [`test/load/`](../../test/load/)
>
> ℹ️ Os resultados deste módulo foram medidos na **versão inicial** da API e são mantidos como registro histórico.

---

## 🎯 Objetivo

**Medir, interpretar e explicar** o comportamento da API sob carga:

- **k6** para gerar carga e definir **SLOs** que falham o teste;
- **Grafana + Prometheus** para ver as métricas **durante** a carga;
- diferenciar gargalos **CPU-bound** e **I/O-bound**, e entender o "joelho da curva".

**Por que importa:** funcionar não basta; precisa funcionar **sob carga**. E "está lento" só vira ação quando se sabe
**quanto**, **em qual percentil** e **por quê**.

---

## 🧠 Conceitos

| Termo | Definição |
|---|---|
| **Throughput** | Trabalho por unidade de tempo; em APIs, **requisições por segundo** |
| **Latência** | Tempo entre enviar a requisição e receber a resposta |
| **Concorrência** | Quantas requisições estão em andamento ao mesmo tempo |
| **VU** (*virtual user*) | Um "usuário" do k6, que executa o script em loop |
| **SLO** | Meta interna (ex.: *p95 < 500 ms*) |
| **SLA** | Compromisso contratual com o cliente, normalmente mais frouxo que o SLO |
| **Error budget** | Quanto de falha o SLO permite. Com 99,9% de disponibilidade: ~43 min/mês |

### Percentis

A média esconde a cauda: com 99 requisições de 10 ms e uma de 5 s, a média é ~60 ms, mas alguém esperou 5 s.

| Percentil | Uso |
|---|---|
| **p50** | Experiência típica |
| **p95** | **O padrão de mercado para SLO**: é o que se monitora |
| **p99** | A cauda: é o que se investiga em incidente |
| **max** | Detectar *outliers* |

### Tipos de teste

| Tipo | Carga | Duração | Pergunta que responde |
|---|---|---|---|
| **Smoke** | 1–10 VUs | Segundos | Funciona? |
| **Load** | A esperada | 5–30 min | Aguenta o normal dentro do SLO? |
| **Stress** | Acima da esperada | 5–30 min | Onde quebra, e como? |
| **Spike** | Pico súbito | 1–5 min | Sobrevive a uma rajada? |
| **Soak** | A normal | Horas | Vaza memória? Degrada com o tempo? |

### CPU-bound × I/O-bound

| | Gargalo | Exemplo no TaskFlow | Como escalar |
|---|---|---|---|
| **CPU-bound** | Processamento | `POST /auth/register` (bcrypt) | Mais CPU, mais instâncias, *worker threads* |
| **I/O-bound** | Esperar rede ou disco | Consultas ao PostgreSQL | Pool de conexões, cache, índices |

### Lei de Little

```text
Concorrência = Throughput × Latência
```

Ela vale para qualquer sistema estável, e os números deste módulo a confirmam: no teste de cadastro com 20 VUs,
**56,48 iterações/s × 0,353 s por iteração ≈ 19,9**, ou seja, os 20 usuários virtuais. Consequência prática:
aumentar a concorrência **não aumenta o throughput para sempre**. Quando o recurso gargalo satura, o throughput
**para de crescer** e toda concorrência extra vira **latência**. Esse é o **joelho da curva**.

---

## 🧰 Ferramentas

| Ferramenta | Por que |
|---|---|
| **k6** (Grafana Labs) | Scripts em JavaScript, **thresholds nativos** (o teste falha se o SLO for violado, ótimo para CI), percentis prontos |
| **autocannon** | Simples, roda via `npm`; usado nos primeiros experimentos e depois substituído pelo k6 |
| **Grafana + Prometheus** | Mostram a latência **durante** a carga, e não só o resumo final |

| Na AWS | Papel |
|---|---|
| Distributed Load Testing on AWS | Gerar carga a partir de várias máquinas |
| CloudWatch · X-Ray | Métricas e traces durante o teste |
| RDS Performance Insights | Descobrir queries lentas no banco |

> Load test em produção real se faz contra **staging** com o mesmo "formato" de produção (mesmo tipo de banco e de
> instância), nunca contra a produção em si.

---

## 📋 Como reproduzir

### 1. Instalar o k6

```powershell
winget install k6      # se falhar com 0x8a15000f, use o instalador MSI do site oficial do k6
k6 version
```

### 2. Desligar o rate limit (só para o teste)

O throttler (Módulo 06) bloqueia depois de 100 req/min, e o cadastro, depois de **3 por minuto**. Sem desligá-lo, o
teste mede o **rate limit**, e não a API (100% de respostas 429).

```powershell
$env:DISABLE_THROTTLE = "true"   # vale para a sessão do terminal; ou DISABLE_THROTTLE=true no .env
npm run start:dev
```

A variável é validada pelo schema de ambiente (só aceita `true`/`false`). O guard continua **registrado** e apenas
deixa de bloquear (`skipIf`); em produção ela fica `false`.

### 3. Smoke: `GET /`

```javascript
// test/load/k6-smoke.js
export const options = { vus: 10, duration: '10s' };

export default function () {
  const res = http.get('http://localhost:3000');
  check(res, {
    'status é 200': (r) => r.status === 200,
    'tempo < 100ms': (r) => r.timings.duration < 100,
  });
  sleep(0.1); // "tempo de pensar" do usuário
}
```

### 4. Load com SLO: `POST /auth/register`

```javascript
// test/load/k6-register.js
export const options = {
  vus: 10,
  duration: '10s',
  thresholds: {
    http_req_failed: ['rate<0.01'],     // < 1% de erro
    http_req_duration: ['p(95)<1000'],  // p95 < 1 s
  },
};

export default function () {
  const email = `load-${__VU}-${__ITER}-${Date.now()}@test.com`; // e-mail único: evita 409
  const res = http.post('http://localhost:3000/auth/register',
    JSON.stringify({ email, name: 'Load Test', password: 'senha12345' }),
    { headers: { 'Content-Type': 'application/json' } });

  check(res, {
    'status é 201': (r) => r.status === 201,
    'não expõe password': (r) => r.json('password') === undefined,
  });
  sleep(0.1);
}
```

```powershell
k6 run test/load/k6-register.js                         # 10 VUs por 10 s (o que está no arquivo)
k6 run --vus 20 --duration 60s test/load/k6-register.js  # a configuração dos resultados abaixo
```

> Cada execução cria usuários de verdade no banco. Depois de alguns testes, o banco de desenvolvimento deste projeto
> chegou a ~5.000 usuários "Load Test".

---

## 📊 Interpretando a saída do k6

```text
█ THRESHOLDS
  http_req_duration  ✓ 'p(95)<1000' p(95)=431.03ms
  http_req_failed    ✓ 'rate<0.01'  rate=0.00%

checks_succeeded...: 100.00% 10230 out of 10230        ← 3.410 requisições × 3 checks

http_req_duration..: avg=252.27ms med=232.39ms p(90)=365.81ms p(95)=431.03ms max=730.67ms
http_reqs..........: 3410   56.48/s
iteration_duration.: avg=353.1ms                       ← requisição (~252 ms) + sleep (100 ms)
vus................: 20
```

| Bloco | Leitura |
|---|---|
| **THRESHOLDS** | ✓ = SLO cumprido. Um ✗ faz o `k6 run` sair com código ≠ 0 e falhar o pipeline |
| **checks** | Corretude **sob carga**: rápido, mas errado, não serve |
| `http_req_duration` | Só a requisição HTTP |
| `iteration_duration` | A volta inteira do VU, **incluindo o `sleep`** (é ela que entra na Lei de Little) |
| `http_reqs` | Total e taxa (throughput) |

### No Grafana, durante a carga

| Linha do painel | Valor (20 VUs, 60 s) |
|---|---|
| p50 | 184 ms |
| p95 | 465 ms |
| p99 | 564 ms |
| Pico de throughput | 56,6 req/s |

O formato esperado é um **platô**: a latência sobe no início, se mantém estável durante a carga e volta a ~0 no fim.
Uma latência que **cresce continuamente** durante uma carga constante indicaria saturação ou vazamento.

### `docker stats` durante o teste

```text
taskflow-postgres     0.02%    55MiB   ← quase parado: o gargalo NÃO é o banco
taskflow-jaeger       0.08%  1.47GiB   ← memória dos traces armazenados
taskflow-grafana      1.70%   568MiB
```

O processo Node.js da API roda **fora** do Docker, então não aparece aqui (veja no Gerenciador de Tarefas). O
PostgreSQL ocioso enquanto a latência sobe é a pista: o gargalo está **na própria aplicação**, no bcrypt.

---

## 📈 Resultados e análise

| Endpoint | Carga | p95 | Throughput | Leitura |
|---|---|---:|---:|---|
| `GET /` | 10 VUs | 7 ms | — | Trivial, sem I/O real |
| `POST /auth/register` | 10 VUs | 183 ms | ~43 req/s | CPU-bound (bcrypt) |
| `POST /auth/register` | 20 VUs | 431 ms | ~56 req/s | **Joelho da curva** |

**Dobrar a concorrência (10 → 20 VUs) aumentou o throughput em ~30%, mas mais que dobrou a latência.** O bcrypt roda
no *thread pool* do libuv, que tem **4 threads** por padrão. Com mais requisições do que threads, elas entram na
fila, e a fila vira latência. O [Módulo 11](11-nodejs-internals.md) explora exatamente esse limite com o
`UV_THREADPOOL_SIZE`.

### Referências de mercado (dependem do negócio)

| Métrica | Desenvolvimento | Staging | Produção |
|---|---|---|---|
| p95 | < 1 s | < 500 ms | **< 200 ms** (leitura) |
| p99 | < 3 s | < 1 s | **< 500 ms** |
| Taxa de erro | < 1% | < 0,1% | **< 0,01%** |
| CPU | < 80% | < 70% | **< 60%** (folga para picos) |

Um app bancário exige p95 bem abaixo de 200 ms; um painel interno tolera segundos. **O SLO vem do negócio**, e
alertas costumam disparar antes de o SLO ser violado (ex.: alerta em 70% do limite).

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | `k6` não reconhecido | PATH não atualizado | Adicionar a pasta do k6 ao PATH do usuário |
| 2 | `winget install k6` falha com `0x8a15000f` | Repositório do winget corrompido | Instalador MSI oficial |
| 3 | 100% das requisições com **429** | O rate limit estava ativo | `DISABLE_THROTTLE=true` durante o teste |
| 4 | autocannon 8 quebrava o body dinâmico | *Breaking change* no `setupRequest`: é preciso modificar o `req` recebido, e não devolver um objeto novo | Migrar para o k6 |
| 5 | `p95` indefinido no autocannon | Ele reporta `p97_5`, e não `p95` | k6, que tem `p(95)` nativo |

### Lições

1. **Rate limit é feature, não bug.** O 429 em massa era o OWASP A04 funcionando. Em produção, testa-se contra staging com limites maiores ou com carga distribuída por IPs.
2. **Isole antes de concluir.** Quando o autocannon devolveu 100% de erros: `Invoke-RestMethod` funcionou → body estático funcionou → body dinâmico falhou. O problema estava na ferramenta, e não na API.
3. **O gargalo pode estar onde não se olha.** Com o banco a 0,02% de CPU, a latência vinha do bcrypt no processo Node.

---

## 🚧 Limitações e próximos passos

- **Endpoints de domínio exigem JWT agora** (Módulo 06): um teste de carga das tarefas precisa de uma fase `setup()` no k6 que registra, faz login e repassa o token aos VUs.
- **Testar a leitura paginada e o histórico**, os endpoints mais usados de verdade, e não só o cadastro.
- **Rodar o k6 no CI** com thresholds: um smoke rápido em cada PR pegaria regressões grosseiras de performance.
- **Cenários com `stages`** (rampa de subida, platô, descida) em vez de VUs fixos, para encontrar o joelho da curva de forma sistemática.
- **Medir de novo com a versão atual da API:** validação de ambiente, autorização e projeções mudaram o caminho de cada requisição desde a medição original.

---

## ✅ Checklist

- [x] Throughput, latência, percentis, SLO, SLA e error budget
- [x] k6 com thresholds que falham o teste
- [x] Smoke (`GET /`) e load com SLO (`POST /auth/register`)
- [x] Leitura da saída do k6, do Grafana e do `docker stats`
- [x] Lei de Little verificada com os próprios números e o joelho da curva identificado
- [x] Gargalo CPU-bound (bcrypt / thread pool) diagnosticado
- [ ] Load test autenticado nos endpoints de tarefas
- [ ] Smoke de performance no CI

---

**Anterior:** [Módulo 09 — Infraestrutura como Código](09-infraestrutura-como-codigo.md) ·
**Próximo:** [Módulo 11 — Node.js internals](11-nodejs-internals.md)
