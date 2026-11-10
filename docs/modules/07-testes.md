# Módulo 07 — Testes (unitários, integração e E2E)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 10/11/2026
>
> **Onde vive no código:** [`test/`](../../test/) · [`jest.config.ts`](../../jest.config.ts) ·
> helpers em [`test/e2e/support/e2e-app.ts`](../../test/e2e/support/e2e-app.ts) e
> [`test/integration/support/test-database.ts`](../../test/integration/support/test-database.ts) ·
> Kafka de teste em [`test/streaming/support/kafka-container.ts`](../../test/streaming/support/kafka-container.ts)

---

## 🎯 Objetivo

Escrever **testes de verdade**: não só o caminho feliz, mas as **propriedades** que o sistema precisa garantir
(autorização, concorrência, idempotência, ordem de efeitos), em três níveis:

| Nível | Testes | Infraestrutura | O que prova |
|---|---:|---|---|
| **Unitários** | 166 | Nenhuma (mocks, ou nem isso) | Regras de domínio, handlers, autorização, ordem `save → publish` |
| **Integração** | 27 | **PostgreSQL real** (Testcontainers) | Concorrência otimista, atomicidade, envelope de metadados, idempotência das projeções, ordem do graceful shutdown |
| **E2E** | 38 | HTTP + PostgreSQL real | 401/400/404/409, anti-IDOR, ciclo de vida, histórico com autor, paginação, `X-Correlation-Id`, health checks |

**Por que importa:** quase todo dev "escreve teste". Pouca gente testa uma *race condition* com 10 escritas
simultâneas contra um banco real, ou prova que uma requisição não autorizada grava **zero** eventos. É a diferença
entre teste como cerimônia e teste como **garantia**.

---

## 🧠 Conceitos

### A pirâmide

```text
          ╱╲          E2E: poucos, lentos, provam que as peças ENCAIXAM
         ╱──╲
        ╱    ╲        Integração: provam contratos com a infraestrutura (banco)
       ╱──────╲
      ╱        ╲      Unitários: muitos, rápidos, provam regras e decisões
     ╱──────────╲
```

| | Unitário | Integração | E2E |
|---|---|---|---|
| Velocidade | ~3 s para os 166 | ~1 min | ~1,5 min |
| Quando rodar | O tempo todo | Ao mexer em banco, Event Store, projeção | Ao mexer em controller, guard, módulo |
| Pega | Regra errada, decisão errada | SQL, constraint, tipo de coluna, `ON CONFLICT` | Guard esquecido, módulo não importado, migração × código |

### AAA e dublês de teste

Todo teste segue **Arrange → Act → Assert**. Os dublês:

| Dublê | O que é | Exemplo no projeto |
|---|---|---|
| **Stub** | Responde um valor fixo | `prisma.user.findUnique.mockResolvedValue(null)` |
| **Mock** | Verifica **como** foi chamado | `expect(eventStore.append).toHaveBeenCalledWith(…, 0)` |
| **Spy** | Observa algo real | `jest.spyOn(Logger.prototype, 'error')` |
| **Fake** | Implementação simplificada que funciona | O runner falso que aplica a mutação num **agregado real** ([`task-lifecycle.handlers.spec.ts`](../../test/unit/task-lifecycle.handlers.spec.ts)) |

### Testcontainers

Sobe um **PostgreSQL real** num container Docker durante os testes e o destrói no final: mesmo banco, mesma versão,
mesmas migrações da produção. Elimina o "passa no mock, quebra em produção".

```text
beforeAll   → sobe postgres:16.15 → prisma migrate deploy (as 6 migrações)
beforeEach  → limpa as tabelas
testes      → contra o banco real
afterAll    → derruba o container
```

---

## 🏗️ Organização

```text
test/
├── setup.ts                    # DISABLE_THROTTLE=true, NODE_ENV=test (antes de tudo)
├── setup-slow-suites.ts        # timeout de 60 s, só para integração, E2E e streaming
├── support/                    # imagens dos containers (as MESMAS tags do compose) e startInMemoryTracing()
├── unit/                       # 27 arquivos, 261 testes (inclui o JSON do dashboard do Grafana)
├── integration/
│   ├── support/test-database.ts   # startTestDatabase(): Postgres + migrações
│   ├── event-replay.spec.ts       # 7 testes (replay pela outbox, UNIQUE parcial, lock por agregado — Módulo 13.6b)
│   ├── event-store.spec.ts        # 18 testes
│   ├── graceful-shutdown.spec.ts  # 3 testes (ordem do app.close() com HTTP real, Módulo 01)
│   ├── notifications-handler.spec.ts # 6 testes (idempotência do consumer, Módulo 13.4)
│   ├── outbox.spec.ts             # 9 testes (atomicidade events + outbox, Módulo 13.2; trace_context)
│   ├── outbox-relay.spec.ts       # 6 testes (lock, duas réplicas, falha, limpeza — Módulo 13.3)
│   ├── projections.spec.ts        # 6 testes
│   └── reports-handler.spec.ts    # 9 testes (guarda de versão, concorrência nos dois níveis, CHECK — Módulo 13.6a)
├── e2e/
│   ├── support/e2e-app.ts         # startE2EApp(), resetDatabase(), registerAndLogin(), eventually()
│   ├── auth.e2e-spec.ts           # 12 testes
│   ├── correlation.e2e-spec.ts    # 5 testes (X-Correlation-Id, Módulo 01)
│   ├── health.e2e-spec.ts         # 3 testes (probes sem token, Módulo 01)
│   ├── notifications.e2e-spec.ts  # 5 testes (GET /me/notifications, Módulo 13.4)
│   ├── reports.e2e-spec.ts        # 5 testes (GET /projects/:id/stats, dono × intruso — Módulo 13.6a)
│   └── tasks.e2e-spec.ts          # 19 testes (inclui API → outbox, Módulo 13.2)
├── streaming/
│   ├── support/kafka-container.ts # startTestKafka(): apache/kafka real, porta anunciada = porta mapeada
│   ├── dead-letter.streaming-spec.ts   # 4 testes (poison pill, falha desconhecida, banco fora, DLT fora — Módulo 13.5)
│   ├── outbox-relay.streaming-spec.ts  # 2 testes (outbox → relay → Kafka → consumer, Módulo 13.3)
│   ├── notifications.streaming-spec.ts # 4 testes (republicação, restart, falha com backoff, um trace só — Módulo 13.4)
│   └── reports.streaming-spec.ts       # 2 testes (dois grupos no mesmo tópico, republicação; reconstrução pelo replay — 13.6a/b)
└── load/                       # k6 e experimentos (NÃO são testes do Jest)
```

O [`jest.config.ts`](../../jest.config.ts) define 4 *projects* (`unit`, `integration`, `e2e`, `streaming`), e os
scripts selecionam cada um:

```bash
npm run test:unit          # --selectProjects unit
npm run test:integration   # --selectProjects integration --runInBand
npm run test:e2e           # --selectProjects e2e --runInBand
npm run test:streaming     # --selectProjects streaming --runInBand (sobe Kafka + Postgres)
npm test                   # unit, integration e e2e em sequência (para no primeiro que falhar)
```

> ⚠️ **Nunca** rodar `npx jest` direto: os scripts passam `--experimental-vm-modules` (algumas libs do NestJS 12
> são ESM) e `--runInBand` (ver lição 6).

---

## 🧪 Parte 1 — Unitários: testar decisões, não implementação

| Arquivo | Testes | O que se destaca |
|---|---:|---|
| [`task.aggregate.spec.ts`](../../test/unit/task.aggregate.spec.ts) | 16 | **Zero mocks**: entram eventos, saem eventos. Invariantes com `it.each` |
| [`env.schema.spec.ts`](../../test/unit/env.schema.spec.ts) | 16 | Congela as regras de segurança da configuração |
| [`create-task.handler.spec.ts`](../../test/unit/create-task.handler.spec.ts) | 12 | Ordem `assertOwner → append → publish`; evento gravado = publicado |
| [`task-command.runner.spec.ts`](../../test/unit/task-command.runner.spec.ts) | 9 | Cada passo do roteiro tem um teste que quebra se o passo sumir |
| [`projects.service.spec.ts`](../../test/unit/projects.service.spec.ts) | 8 | A query de posse filtra por `id` **e** `ownerId` |
| demais (7 arquivos) | 40 | Auth, repositório, projeções, histórico, listagem, handlers |

### Padrões que valem para qualquer projeto

**1. Teste o que o código pede, e não só o que ele devolve.** O teste mais importante da autorização não é
"lança 404", porque um mock devolvendo `null` passaria mesmo se alguém apagasse o filtro. É este:

```ts
it('deve filtrar por id E ownerId na MESMA query', async () => {
  await service.findOwned(projectId, ownerId);
  expect(prisma.project.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: projectId, ownerId } }),
  );
});
```

**2. Ordem é regra de negócio.** Quando há efeitos irreversíveis (um Event Store *append-only*), a ordem merece
teste próprio:

```ts
it('deve verificar a posse ANTES de gravar no Event Store', async () => {
  const ordem: string[] = [];
  projects.assertOwner.mockImplementation(async () => { ordem.push('assertOwner'); });
  eventStore.append.mockImplementation(async () => { ordem.push('append'); });

  await handler.execute(new CreateTaskCommand(userId, 'p1', 'Tarefa'));

  expect(ordem).toEqual(['assertOwner', 'append']);
});
```

**3. Prove a ausência de efeito.** "Negou o acesso" não basta; prove que **nada** foi gravado nem publicado.

**4. Propriedades de segurança como teste.** Mesma mensagem para "usuário não existe" e "senha errada"; o `select`
que não expõe o `ownerId`; o segredo curto que impede o boot. Se alguém afrouxar a regra, o PR fica vermelho.

**5. Dependências escondidas atrapalham.** O agregado recebe `complete(now: Date)` em vez de chamar `new Date()`:
o teste controla o tempo sem `jest.useFakeTimers()`.

---

## 🧪 Parte 2 — Integração: contratos com o banco

Mock prova **intenção**; integração prova **efeito**. Constraints, `ON CONFLICT` e tipos de coluna só se provam
contra o banco real.

| Teste | Por que só funciona contra o banco real |
|---|---|
| **10 `append` simultâneos** na mesma versão → exatamente 1 sucesso e 9 `ConcurrencyConflictError` | A atomicidade vem do `UNIQUE` do Postgres; nenhum mock simula isso |
| `appendMany` com conflito → **nenhum** evento do lote gravado | Atomicidade de um `INSERT` com N linhas |
| Entrega duplicada e **5 entregas simultâneas** do mesmo evento → 1 linha | Prova que o `skipDuplicates` chega ao banco como `ON CONFLICT DO NOTHING` |
| **Replay completo** de todos os eventos → mesmo estado final | Todas as projeções precisam ser idempotentes juntas |
| `UPDATE … SET status = 'FEITO'` → recusado | O enum do Postgres protege o dado até de SQL direto |

```ts
it('deve aceitar EXATAMENTE UM de N appends simultâneos na mesma versão', async () => {
  await eventStore.append(evento('task-1', 'TaskCreated'), 0);

  const resultados = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => eventStore.append(evento('task-1', 'TaskUpdated', { i }), 1)),
  );

  expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(resultados.filter((r) => r.status === 'rejected' && r.reason instanceof ConcurrencyConflictError))
    .toHaveLength(9); // o erro CERTO, não um timeout qualquer
});
```

O `Promise.allSettled` (e não `Promise.all`) espera **todas** as tentativas e mostra o desfecho de cada uma.

---

## 🧪 Parte 3 — E2E: as peças encaixam

Os E2E sobem a aplicação inteira (com o **mesmo** `configureApp()` da produção) contra um PostgreSQL real e
exercitam a API via HTTP com **dois usuários**, o dono e um intruso:

| Grupo | Cenários |
|---|---|
| Segurança | 401 sem token · 400 UUID inválido · intruso recebe 404 **e zero eventos são gravados** · **anti-IDOR** entre dois projetos do mesmo dono |
| CQRS | A tarefa criada aparece no Read Model com prioridade e prazo · validação do body · paginação "sem repetição nem buracos" · teto de 100 |
| Ciclo de vida | atribuir → iniciar → concluir · 409 em tarefa concluída · `PATCH status=DONE` → 400 · histórico com 4 eventos |
| Auth | registro, 409 duplicado, mass assignment, login, `/auth/me` com token válido, ausente, falso e malformado |

### O helper `startE2EApp()`

```ts
export async function startE2EApp(): Promise<E2EContext> {
  // A MESMA tag do docker-compose.yml (test/support/postgres-image.ts): Debian, não Alpine,
  // porque a musl libc do Alpine tem suporte limitado a locale e pode ordenar texto diferente
  const container = await new PostgreSqlContainer(POSTGRES_TEST_IMAGE).start();
  process.env.DATABASE_URL = container.getConnectionUri();
  process.env.JWT_SECRET = 'e2e-test-secret-com-no-minimo-32-caracteres';
  execSync('npx prisma migrate deploy', { /* ... */ });

  // Carregamento TARDIO: o ConfigModule valida o ambiente no momento em que o AppModule é carregado.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../../src/app.module') as typeof import('../../../src/app.module');

  const app = (await Test.createTestingModule({ imports: [AppModule] }).compile()).createNestApplication();
  configureApp(app); // a MESMA configuração HTTP da produção
  await app.init();
  // ...
}
```

### Consistência eventual: `eventually()` e não `sleep()`

As projeções rodam **depois** da resposta HTTP. Ler o Read Model logo após o `POST` pode não encontrar a tarefa ainda.

```ts
await eventually(async () => {
  expect(await findInReadModel(taskId)).toMatchObject({ priority: 'HIGH' });
});
```

O `eventually` repete a asserção até ela passar ou estourar o tempo. Um `sleep(500)` seria **lento** quando a
projeção leva 5 ms e **instável** quando a máquina do CI está lenta e ela leva 600 ms. E ele é usado **só** onde há
projeção: as respostas dos comandos são lidas na hora, porque esconder bugs atrás de polling também é um problema.

---

## 🧪 Parte 4 — Streaming: Kafka de verdade (Módulo 13)

A suíte `test:streaming` prova o caminho que nenhum mock prova: evento gravado pelo código real → outbox → relay →
**Kafka real** → um consumer lendo o tópico, conferindo chave, partição, ordem e headers. É ela que o 4º job do CI
roda ([Módulo 03](03-ci-cd-github-actions.md)).

**Por que `GenericContainer`, e não o `KafkaContainer` do Testcontainers:** o módulo `@testcontainers/kafka` só sobe
as imagens da Confluent (ele chama `/etc/confluent/docker/run`). O teste usa a imagem oficial `apache/kafka:4.3.2`,
a mesma do compose, com um detalhe que faz funcionar: o cliente usa o endereço que o broker **anuncia**, e com porta
aleatória o broker anunciaria a porta interna. Por isso o helper escolhe uma porta livre **antes** de subir e a
mapeia de forma fixa: anunciado e mapeado são o mesmo `localhost:<porta>` (o problema dos "dois listeners" do
[Módulo 13](13-mensageria-kafka.md)).

**Testes que provam que pegam o bug (mutação manual).** Doze testes do Módulo 13 foram conferidos quebrando o código
de propósito:

| Mutação | Teste que falhou | O que mostrou |
|---|---|---|
| Tirar o mapper da outbox do `CreateTaskHandler` (13.2) | E2E `outbox` | O `TaskCreated` some da outbox |
| Trocar o advisory lock do relay por `SELECT true` (13.3) | Integração "duas réplicas simultâneas" | **400 envios para 200 eventos**: cada mensagem publicada duas vezes |
| Gravar a marca de `processed_events` fora da transação do efeito (13.4) | Integração "efeito falhou" | Evento marcado e nenhuma notificação: perdida para sempre |
| Criar o span `process` do consumer sem o contexto do header (trace pela outbox) | Streaming "um trace só" | O consumer cai num trace novo: `traceId` diferente do request |
| Tirar a classificação de falha de banco (13.5) | Streaming "falha de banco" | A mensagem vai ao DLT depois de 2 tentativas. Com processos reais: 6 de 40 eventos legítimos no DLT em 45 s de Postgres fora |
| Tirar a guarda de versão do `reports` (13.6a) | Integração: 3 testes | Duplicata, versão antiga e entregas simultâneas aplicadas de novo |
| "Ler, somar e gravar" o contador no lugar de `SET coluna = coluna + delta` (13.6a) | Integração "20 tarefas em paralelo" | **`done = 3` para 20 conclusões**: 17 perdidas (*lost update*) |
| Tirar o `FOR UPDATE` do `reports` (13.6a) | Integração "5 entregas simultâneas" | O `-1` aplicado duas vezes; quem barra é o CHECK do banco |
| Tirar o lock por agregado do `appendMany` ou do replay (13.6b) | Integração "com o lock preso, a gravação ESPERA" | A gravação não espera: API e replay poderiam intercalar na mesma tarefa |
| `notifications` aceitando replay (13.6b) | Streaming "reconstrução do reports" | Notifica a atribuição de uma tarefa anterior à outbox. Na 1ª versão do teste, esta mutação **sobreviveu** (problema 16) |
| Commitar o offset mesmo sem o ack do DLT (13.5) | Streaming "DLT indisponível" | A mensagem de trás fura a fila. Na 1ª versão do teste, esta mutação **sobreviveu** (problema 14) |

Um teste que nunca foi visto falhando pode estar testando nada; esta é a versão barata do *mutation testing*.

**Testando traces.** [`startInMemoryTracing()`](../../test/support/in-memory-tracing.ts) registra o SDK de trace com
os spans em memória, e o teste lê o que teria ido para o Jaeger (pai, `traceId`, links). Ele registra as **três**
peças globais que o `NodeSDK` registra em produção: tracer provider, propagador W3C e context manager com
`AsyncLocalStorage`. Faltando o propagador, `inject`/`extract` são no-op; faltando o context manager,
`startActiveSpan` não deixa o span ativo para o código chamado. Nos dois casos o código "funciona" sem propagar nada,
e é por isso que a mutação acima foi conferida: o teste precisa ser visto falhando.

---

## ⚠️ Problemas encontrados e as lições

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | `Cannot find module '@nestjs/testing'` (ESM) | Jest em CommonJS | `--experimental-vm-modules` nos scripts |
| 2 | `secretOrPrivateKey must have a value` | `JwtModule.register()` lia o ambiente na importação | `registerAsync({ inject: [ConfigService], useFactory })` |
| 3 | O throttle devolvia 429 nos E2E | Guard global difícil de substituir (`useGlobalGuards`, `overrideGuard` e `overrideProvider(APP_GUARD)` não funcionam) | Guard sempre registrado + **`skipIf`** lendo `DISABLE_THROTTLE` |
| 4 | E2E levando 9 minutos | Containers órfãos do Testcontainers | `docker ps -a` + `docker rm -f` |
| 5 | **O E2E poderia apagar o banco de desenvolvimento** | Com o `AppModule` importado no topo, o `ConfigService` lia o `.env` local **antes** de o teste definir o banco do container, e o `deleteMany` do teste rodaria no banco de dev | Carregamento tardio do `AppModule`, centralizado no `startE2EApp()` |
| 6 | **Docker Desktop caiu** ao rodar todas as suítes | 4+ PostgreSQL de teste em paralelo + o ambiente de dev esgotaram a memória | `--runInBand` nas suítes com Testcontainers; `npm test` em sequência |
| 7 | Hook estourou 5 s sob carga | **`testTimeout` dentro de `projects` é ignorado pelo Jest** (verificado com um teste de 5,5 s) | `jest.setTimeout(60_000)` em `setupFilesAfterEnv`, só para integração/E2E; unitários continuam com 5 s |
| 8 | Teste passava e o `tsc` falhava | O `ts-jest` só transpila (`isolatedModules`) | `tsc --noEmit` antes dos testes, no CI e localmente |
| 9 | O E2E testava outra configuração | Helmet e `ValidationPipe` montados à mão, sem CORS nem conversão implícita | `configureApp()` compartilhado com o `main.ts` |
| 10 | Testes que **nunca rodavam** | `app.controller.spec.ts`, `app.e2e-spec.ts` e `jest-e2e.json` fora do `testMatch` | Removidos: teste morto dá falsa sensação de cobertura |
| 11 | `import()` dinâmico funcionou no Jest e quebrou no `tsc` | Com `module: nodenext`, `import()` exige extensão `.js` | `require` tipado com `typeof import(...)` |
| 12 | **(13.3)** O teste do lock travou por 60 s | `$queryRaw` com `SELECT pg_advisory_xact_lock(...)`: a função devolve `void`, que o Prisma não desserializa; a promessa que liberaria o teste nunca resolveu | `$executeRaw` para comandos sem resultado |
| 13 | **(13.3)** O teste das duas réplicas falhou na mutação antes de mostrar as duplicatas | A primeira asserção (houve disputa pelo lock) já falha sem lock | Rodar a mutação também sem essa asserção, para ver o efeito real (400 envios) |
| 14 | **(13.5)** O teste "DLT indisponível" passava, e a mutação "commitar sem o ack do DLT" **também passava** | O teste dormia 12 s antes de criar o tópico do DLT; o join do grupo atrasou o 1º envio, o tópico apareceu antes do timeout de 10 s, e o envio **nunca falhou** | Esperar o erro acontecer (o log do runner) em vez de dormir. A mutação passou a quebrar o teste pelo motivo certo: a mensagem de trás furando a fila |
| 15 | **(13.6a)** No CI, `pendingStats` falhou com idade **89,999889 s** onde o teste exige ≥ 90 (instável: nunca falhou localmente) | O teste gravava `now() - 90 s` numa coluna `TIMESTAMP(3)`, e o Postgres **arredonda** ao gravar (conferido: `.000611` vira `.001`). O instante ficava até 0,5 ms no futuro; com o `SELECT` seguinte mais rápido que isso, a idade saía abaixo de 90 | `date_trunc('milliseconds', …)` no teste. O código de produção não muda: meio milissegundo numa métrica em segundos é irrelevante. Lição: teste não pode exigir precisão abaixo da coluna |
| 16 | **(13.6b)** O teste "o notifications ignora o replay" passava também com a proteção desligada | As mensagens de replay tinham eventIds já processados, e o `processed_events` as descartava com ou sem o header `replay` | Uma tarefa gravada só no Event Store (nunca publicada) entrou no teste: é o caso em que o header é a ÚNICA barreira. Mesma lição do problema 14, por outro caminho: a mutação mostra se o teste exercita a proteção que diz proteger |

### As lições que ficam

1. **O ambiente precisa existir antes de o módulo ser carregado.** Vale para `registerAsync` (lê na instanciação) e para o carregamento tardio do `AppModule` nos E2E.
2. **Prefira desligar a feature a lutar contra o framework.** O `skipIf` resolveu em uma linha o que três tentativas de *override* não resolveram.
3. **Configuração que parece funcionar pode não fazer nada.** O `testTimeout` estava no arquivo desde o início, plausível, e era ignorado. Só um experimento revelou.
4. **Paralelismo só acelera quando sobra recurso.** Sem memória, ele trava a máquina.
5. **Teste com consistência eventual: rode 3 vezes antes de confiar.**
6. **Um teste de caminho de erro só prova algo se o erro aconteceu.** Dormir um tempo "suficiente" e torcer não é
   provocar a falha; só a mutação mostrou que o teste do DLT indisponível nunca a exercitava.

---

## 📊 Resultados

| Momento | Unitários | Integração | E2E |
|---|---:|---:|---:|
| Primeira versão deste módulo | 13 | 8 | 12 + 1 `todo` |
| Antes do Módulo 13 | 166 | 27 | 38 |
| **Hoje** | **261** | **64** | **49** |

Mais **12 testes de streaming** (Kafka real), em ~62 s com as imagens em cache (o do DLT indisponível espera um
timeout real de 10 s do produtor).

A suíte completa (`npm test`, em sequência) leva cerca de 3 minutos numa máquina de desenvolvimento com 8 GB
reservados ao Docker. No CI, as quatro suítes rodam em VMs separadas e em paralelo.

---

## 🚧 Limitações e próximos passos

- **Cobertura não publicada:** o `test:cov` existe, mas o relatório não aparece no PR.
- **Sem teste de contrato da API:** uma mudança no formato da resposta só é pega se algum E2E checar aquele campo. Um *snapshot* do documento OpenAPI (`/docs-json`, gerado pelo Swagger) no CI pegaria *breaking changes*.
- **Sem teste de mutação** (ex.: Stryker): mediria se os testes realmente falham quando o código muda.
- **E2E de concorrência via HTTP:** a race condition é provada na integração; um teste HTTP com requisições paralelas seria o próximo nível.

---

## ✅ Checklist

- [x] Pirâmide completa, com 4 *projects* no Jest (incluindo streaming com Kafka real)
- [x] Agregado testado sem mocks
- [x] Testes de ordem e de ausência de efeito colateral
- [x] Integração com PostgreSQL real: concorrência, atomicidade, idempotência
- [x] E2E com a mesma configuração da produção, dono × intruso
- [x] Consistência eventual com `eventually()`
- [x] Helpers de teste sem setup duplicado
- [x] Suítes pesadas estáveis em máquina modesta (`--runInBand`, timeout correto)
- [x] Mutação manual nos testes críticos da outbox, do relay, do consumer, do trace e do DLT
- [ ] Cobertura no PR, testes de contrato e mutation testing automatizado (Stryker)

---

**Anterior:** [Módulo 06 — Segurança (OWASP Top 10)](06-seguranca-owasp.md) ·
**Próximo:** [Módulo 08 — IA no desenvolvimento](08-ia-no-desenvolvimento.md)
