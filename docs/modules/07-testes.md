# Módulo 07 — Testes (unitários, integração e E2E)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** [`test/`](../../test/) · [`jest.config.ts`](../../jest.config.ts) ·
> helpers em [`test/e2e/support/e2e-app.ts`](../../test/e2e/support/e2e-app.ts) e
> [`test/integration/support/test-database.ts`](../../test/integration/support/test-database.ts)

---

## 🎯 Objetivo

Escrever **testes de verdade**: não só o caminho feliz, mas as **propriedades** que o sistema precisa garantir
(autorização, concorrência, idempotência, ordem de efeitos), em três níveis:

| Nível | Testes | Infraestrutura | O que prova |
|---|---:|---|---|
| **Unitários** | 101 | Nenhuma (mocks, ou nem isso) | Regras de domínio, handlers, autorização, ordem `save → publish` |
| **Integração** | 20 | **PostgreSQL real** (Testcontainers) | Concorrência otimista, atomicidade, idempotência das projeções |
| **E2E** | 29 | HTTP + PostgreSQL real | 401/400/404/409, anti-IDOR, ciclo de vida, histórico, paginação |

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
| Velocidade | ~3 s para os 101 | ~1 min | ~1,5 min |
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
beforeAll   → sobe postgres:16-alpine → prisma migrate deploy (as 6 migrações)
beforeEach  → limpa as tabelas
testes      → contra o banco real
afterAll    → derruba o container
```

---

## 🏗️ Organização

```text
test/
├── setup.ts                    # DISABLE_THROTTLE=true, NODE_ENV=test (antes de tudo)
├── setup-slow-suites.ts        # timeout de 60 s, só para integração e E2E
├── unit/                       # 12 arquivos, 101 testes
├── integration/
│   ├── support/test-database.ts   # startTestDatabase(): Postgres + migrações
│   ├── event-store.spec.ts        # 14 testes
│   └── projections.spec.ts        # 6 testes
├── e2e/
│   ├── support/e2e-app.ts         # startE2EApp(), resetDatabase(), registerAndLogin(), eventually()
│   ├── auth.e2e-spec.ts           # 12 testes
│   └── tasks.e2e-spec.ts          # 17 testes
└── load/                       # k6 e experimentos (NÃO são testes do Jest)
```

O [`jest.config.ts`](../../jest.config.ts) define 3 *projects* (`unit`, `integration`, `e2e`), e os scripts
selecionam cada um:

```bash
npm run test:unit          # --selectProjects unit
npm run test:integration   # --selectProjects integration --runInBand
npm run test:e2e           # --selectProjects e2e --runInBand
npm test                   # os três, em sequência (para no primeiro que falhar)
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
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
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

### As lições que ficam

1. **O ambiente precisa existir antes de o módulo ser carregado.** Vale para `registerAsync` (lê na instanciação) e para o carregamento tardio do `AppModule` nos E2E.
2. **Prefira desligar a feature a lutar contra o framework.** O `skipIf` resolveu em uma linha o que três tentativas de *override* não resolveram.
3. **Configuração que parece funcionar pode não fazer nada.** O `testTimeout` estava no arquivo desde o início, plausível, e era ignorado. Só um experimento revelou.
4. **Paralelismo só acelera quando sobra recurso.** Sem memória, ele trava a máquina.
5. **Teste com consistência eventual: rode 3 vezes antes de confiar.**

---

## 📊 Resultados

| Momento | Unitários | Integração | E2E |
|---|---:|---:|---:|
| Primeira versão deste módulo | 13 | 8 | 12 + 1 `todo` |
| **Hoje** | **101** | **20** | **29** |

A suíte completa (`npm test`, em sequência) leva cerca de 3 minutos numa máquina de desenvolvimento com 8 GB
reservados ao Docker. No CI, as três suítes rodam em VMs separadas e em paralelo.

---

## 🚧 Limitações e próximos passos

- **Cobertura não publicada:** o `test:cov` existe, mas o relatório não aparece no PR.
- **Sem teste de contrato da API:** uma mudança no formato da resposta só é pega se algum E2E checar aquele campo. Um *snapshot* do documento OpenAPI (`/docs-json`, gerado pelo Swagger) no CI pegaria *breaking changes*.
- **Sem teste de mutação** (ex.: Stryker): mediria se os testes realmente falham quando o código muda.
- **E2E de concorrência via HTTP:** a race condition é provada na integração; um teste HTTP com requisições paralelas seria o próximo nível.

---

## ✅ Checklist

- [x] Pirâmide completa, com 3 *projects* no Jest
- [x] Agregado testado sem mocks
- [x] Testes de ordem e de ausência de efeito colateral
- [x] Integração com PostgreSQL real: concorrência, atomicidade, idempotência
- [x] E2E com a mesma configuração da produção, dono × intruso
- [x] Consistência eventual com `eventually()`
- [x] Helpers de teste sem setup duplicado
- [x] Suítes pesadas estáveis em máquina modesta (`--runInBand`, timeout correto)
- [ ] Cobertura no PR, testes de contrato e de mutação

---

**Anterior:** [Módulo 06 — Segurança (OWASP Top 10)](06-seguranca-owasp.md) ·
**Próximo:** [Módulo 08 — IA no desenvolvimento](08-ia-no-desenvolvimento.md)
