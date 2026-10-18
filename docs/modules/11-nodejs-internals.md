# Módulo 11 — Node.js Internals (Event Loop, Thread Pool, Streams, Memory Leaks)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** experimentos em [`test/load/`](../../test/load/) (`event-loop.js`, `read-sync.js`,
> `read-stream.js`, `copy-stream.js`, `generate-file.js`, `memory-leak.js`) · bcrypt no
> [`auth.service.ts`](../../src/modules/auth/auth.service.ts)

---

## 🎯 Objetivo

Entender o que acontece **por baixo** do Node.js, para explicar **por que** um código é rápido ou lento:

- o **Event Loop** e a ordem de execução;
- o **thread pool** do libuv, e por que ele limita o bcrypt;
- **Worker Threads** para CPU pesada em JavaScript;
- **Streams e backpressure** para dados grandes;
- **memory leaks**, e como encontrá-los.

**Por que importa:** é o conhecimento que transforma "a API ficou lenta" em "o thread pool saturou com 4 threads e
as requisições de cadastro estão na fila", ou seja, de um sintoma num diagnóstico.

---

## 🧠 Conceitos

### 1. Event Loop

O Node executa **JavaScript numa única thread**. O Event Loop é o laço que, a cada volta, passa por fases e executa
os callbacks que estão prontos:

| Fase | Executa |
|---|---|
| **timers** | `setTimeout` / `setInterval` vencidos |
| **pending callbacks** | Alguns callbacks de I/O do sistema adiados |
| **poll** | Recebe novos eventos de I/O (e espera por eles, se não houver mais nada) |
| **check** | `setImmediate` |
| **close callbacks** | `socket.on('close')` e similares |

**Microtasks não são uma fase.** A fila de microtasks (`process.nextTick` primeiro, depois Promises) é **esvaziada
inteira depois de cada callback**, em qualquer fase. Por isso uma Promise resolvida sempre roda antes do próximo
timer, e por isso um loop infinito de microtasks **trava** o Event Loop (o *starvation*).

> **A regra que importa:** enquanto um código síncrono roda, **nada mais** roda: nem outra requisição, nem timer,
> nem I/O. Um cálculo de 200 ms numa rota trava **todas** as requisições por 200 ms.

### 2. Thread pool do libuv

O JavaScript roda numa thread, mas o **libuv** mantém um **pool de threads** (4, por padrão) para operações que o
sistema operacional não oferece de forma assíncrona:

| Usa o thread pool | **Não** usa o thread pool |
|---|---|
| `fs` (leitura e escrita de arquivos) | **Rede** (sockets TCP/HTTP), que usa o mecanismo assíncrono do SO (epoll, kqueue, IOCP) |
| `dns.lookup` | `dns.resolve*` |
| `crypto` assíncrono (`pbkdf2`, `scrypt`, `randomBytes`) | Timers |
| `zlib` assíncrono | Código JavaScript |
| Addons nativos que optam por ele, como o **bcrypt** | |

O tamanho é definido por **`UV_THREADPOOL_SIZE`**, lido **uma vez**, quando o pool é criado. Precisa ser definido
**antes** de o processo iniciar.

### 3. CPU-bound × I/O-bound

| | Gargalo | Exemplo | Solução |
|---|---|---|---|
| **CPU-bound** | Processamento | bcrypt, parsing de JSON gigante, compressão | Thread pool, Worker Threads, mais núcleos, mais instâncias |
| **I/O-bound** | Esperar rede ou disco | Consultas ao banco, chamadas HTTP | Concorrência, pool de conexões, cache |

### 4. Worker Threads

Threads que executam **JavaScript em paralelo**, cada uma com seu próprio Event Loop e heap. Servem para CPU pesada
**em JavaScript** (o thread pool só atende operações nativas): processamento de imagem, cálculo, parsing de arquivos
enormes.

### 5. Streams e backpressure

Processar dados **em pedaços** (*chunks* de ~64 KB), em vez de carregar tudo na memória:

| Tipo | Exemplo |
|---|---|
| `Readable` | Leitura de arquivo, body de requisição |
| `Writable` | Escrita de arquivo, resposta HTTP |
| `Duplex` | Socket TCP |
| `Transform` | gzip, criptografia, conversão de CSV |

**Backpressure** é o freio: quando o destino é mais lento que a origem, a leitura **pausa** até o destino esvaziar.
O `writable.write()` devolve `false` quando o buffer interno enche; quem escreve deve esperar o evento `'drain'`.
O `.pipe()` e o `stream.pipeline()` fazem isso sozinhos, e o `pipeline()` também **propaga erros e fecha todos os
streams**. Por isso ele é a forma recomendada hoje.

### 6. Memory leak e heap snapshot

Um vazamento acontece quando um objeto que não é mais necessário continua **alcançável** a partir de uma referência
viva (variável global, cache, listener, closure). O garbage collector não pode liberá-lo, e a memória cresce até o
processo ser morto (*OOM*).

O **heap snapshot** é uma "foto" do heap. Comparar duas fotos tiradas em momentos diferentes mostra **quais objetos
cresceram** e **quem os segura**.

---

## 🧪 Experimentos

### Experimento 1 — Ordem de execução ([`event-loop.js`](../../test/load/event-loop.js))

```javascript
console.log('1. Início');
setTimeout(() => console.log('2. setTimeout'), 0);
Promise.resolve().then(() => console.log('3. Promise'));
process.nextTick(() => console.log('4. process.nextTick'));
setImmediate(() => console.log('5. setImmediate'));
console.log('6. Fim do sync');
```

```text
1. Início
6. Fim do sync         ← código síncrono primeiro
4. process.nextTick    ← microtasks: nextTick antes das Promises
3. Promise
2. setTimeout   ┐      ← a ordem entre estes dois NÃO é garantida
5. setImmediate ┘
```

As quatro primeiras linhas saem **sempre** nessa ordem. Já entre `setTimeout(0)` e `setImmediate`, **no script
principal**, a ordem depende de quanto o processo leva para entrar no Event Loop: **6 execuções seguidas deram 3 × 3**,
alternando. Só **dentro de um callback de I/O** a ordem é garantida, com `setImmediate` primeiro (a fase `check` vem
logo depois da `poll`).

> **Lição:** um experimento que roda uma vez prova pouco. A primeira versão deste módulo registrou a ordem como fixa.

### Experimento 2 — Thread pool × bcrypt

Teste de carga com k6 no `POST /auth/register` (bcrypt custo 10), variando o tamanho do pool:

| `UV_THREADPOOL_SIZE` | Throughput | Latência média | p95 |
|---:|---:|---:|---:|
| 1 | 17 req/s | 466 ms | 506 ms |
| 4 (padrão) | 40 req/s | 147 ms | 207 ms |
| 8 | 50 req/s | 95 ms | 137 ms |

- **1 thread:** todo hash entra numa fila única; a concorrência vira latência pura.
- **1 → 4:** o throughput mais que dobra.
- **4 → 8:** ganho de ~25%, bem menor. Retorno decrescente: a partir daí, o limite passa a ser **a CPU física**.

**Regra prática:** para trabalho **CPU-bound** no pool (como o bcrypt), threads além do número de núcleos só trazem
troca de contexto. Para trabalho de **disco** (`fs`), um pool maior pode ajudar, porque as threads passam a maior
parte do tempo esperando.

**Ligação com o código:** o `AuthService` usa `bcrypt.hash()`/`bcrypt.compare()` **assíncronos**, que rodam no pool
e não travam o Event Loop. As versões síncronas (`hashSync`) bloqueariam **todas** as requisições durante cada hash.

### Experimento 3 — Arquivo de 100 MB: síncrono × stream

```powershell
node test/load/generate-file.js   # cria test/load/large-file.txt (ignorado pelo Git)
node test/load/read-sync.js
node test/load/read-stream.js
node test/load/copy-stream.js     # cópia com .pipe() (backpressure automático)
```

| | `readFileSync` | `createReadStream` |
|---|---:|---:|
| Tempo | 74 ms | 144 ms |
| Memória do heap | ~100 MB | **0,46 MB** |
| Event Loop | **Bloqueado** durante a leitura | Livre entre os chunks |

O síncrono é ~2× mais rápido **para um único arquivo**, mas segura o processo inteiro e consome memória proporcional
ao arquivo. Com 10 downloads simultâneos de 500 MB, a versão síncrona precisaria de ~5 GB; a com stream, de alguns MB.

> ⚠️ **O próprio `generate-file.js` viola o backpressure:** ele chama `writeStream.write()` 100 vezes em sequência
> **sem checar o retorno**, então os 100 MB ficam enfileirados na memória antes de chegar ao disco. Para um script
> de laboratório, tudo bem; num servidor, seria um vazamento por pico. O certo seria esperar o `'drain'` quando
> `write()` devolve `false`, ou gerar os dados como um `Readable` ligado por `pipeline()`.

### Experimento 4 — Memory leak ([`memory-leak.js`](../../test/load/memory-leak.js))

```javascript
const cacheGlobal = []; // referência global: nada aqui é liberado

setInterval(() => {
  for (let i = 0; i < 100; i++) {
    cacheGlobal.push({ id: i, payload: 'X'.repeat(1024) }); // ~100 KB por segundo, para sempre
  }
  console.log(`Memória: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB`);
}, 1000);
```

**Sintoma:** `heapUsed` crescendo sem parar, sem nunca cair depois do GC.

**Diagnóstico com heap snapshot:**

1. `node --inspect test/load/memory-leak.js`
2. Chrome → `chrome://inspect` → *Open dedicated DevTools for Node*
3. Aba **Memory** → *Take snapshot*; esperar; outro snapshot
4. Comparar (*Comparison*) e ordenar por *Size Delta*: o `Array` do `cacheGlobal` lidera o crescimento

**Correções:** cache com limite (LRU, ex.: `lru-cache`), expiração (TTL), cache externo (Redis), e todo `.on()` com
o `.off()` correspondente.

---

## 🧩 Aplicações práticas

| Situação | Problema sem o conceito | Solução |
|---|---|---|
| Exportar um extrato CSV de 500 MB | `res.send(buffer)` aloca o arquivo inteiro **por requisição** | `pipeline(fs.createReadStream(…), res)`: memória constante |
| Processar 1 milhão de registros com parsing pesado | O Event Loop trava, e todas as rotas param | Worker Threads, ou processar em lotes que cedem o loop |
| Sessões guardadas num `Map` em memória | Cresce para sempre (o clássico do Experimento 4) e não é compartilhado entre réplicas | Redis com TTL |
| Muitos cadastros simultâneos | Fila no thread pool (4 threads) | Mais instâncias; ajustar `UV_THREADPOOL_SIZE` aos núcleos |

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | Mudar `UV_THREADPOOL_SIZE` não teve efeito | O pool é criado uma vez; a variável foi definida com o processo já rodando | Definir antes de iniciar o Node |
| 2 | 8 threads não dobraram o throughput | A CPU física virou o gargalo | Threads ≈ núcleos para trabalho CPU-bound |
| 3 | Ler um arquivo grande travou o processo | `readFileSync` bloqueia o Event Loop | Streams |
| 4 | Memória alta ao **gerar** o arquivo de 100 MB | `write()` em loop, ignorando o retorno (sem backpressure) | Esperar `'drain'` ou usar `pipeline()` |
| 5 | Memória crescendo indefinidamente | Referência global num cache sem limite | Heap snapshot para achar; LRU/TTL para corrigir |
| 6 | Ordem `setTimeout`/`setImmediate` registrada como fixa | Uma única execução foi tomada como regra | Rodar várias vezes: no script principal, a ordem é não determinística |

### Lições

1. **Uma thread para JavaScript, várias para o resto.** O Event Loop não bloqueia em I/O, mas bloqueia em qualquer código síncrono pesado.
2. **O thread pool é um recurso finito e compartilhado.** bcrypt, `fs` e `dns.lookup` disputam as mesmas 4 threads.
3. **Streams trocam um pouco de velocidade por memória constante**, e é essa troca que faz um servidor escalar.
4. **Vazamentos são silenciosos.** Monitore o `heapUsed` ao longo do tempo (um *soak test*, do Módulo 10) e investigue com snapshots.

---

## 🚧 Limitações e próximos passos

- Os experimentos são **scripts isolados** em `test/load/`; o lugar natural seria uma pasta `labs/`, fora de `test/`.
- **Medir o atraso do Event Loop em produção** (`perf_hooks.monitorEventLoopDelay`) e exportá-lo como métrica no Prometheus, para ver travamentos antes que virem incidentes.
- **Experimento com Worker Threads** (o único conceito do módulo sem experimento próprio).
- Corrigir o `generate-file.js` para respeitar o backpressure, como exemplo positivo.

---

## ✅ Checklist

- [x] Fases do Event Loop e o lugar real das microtasks
- [x] O que usa (e o que não usa) o thread pool
- [x] `UV_THREADPOOL_SIZE` medido com 1, 4 e 8 threads
- [x] Streams × síncrono medido (100 MB × 0,46 MB)
- [x] Backpressure: o que é, quem respeita (`pipe`, `pipeline`) e um exemplo que viola
- [x] Memory leak provocado e diagnosticado com heap snapshot
- [ ] Experimento com Worker Threads
- [ ] Métrica de atraso do Event Loop no Prometheus

---

**Anterior:** [Módulo 10 — Performance e load testing](10-performance-load-testing.md) ·
**Próximo:** [Módulo 12 — Design patterns](12-design-patterns.md)
