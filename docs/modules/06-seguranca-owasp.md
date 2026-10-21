# Módulo 06 — Segurança (OWASP Top 10)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** [`src/app.setup.ts`](../../src/app.setup.ts) (Helmet, CORS, validação) ·
> [`src/modules/auth/`](../../src/modules/auth/) · [`projects.service.ts`](../../src/modules/projects/projects.service.ts)
> (`assertOwner`) · [`src/config/env.schema.ts`](../../src/config/env.schema.ts) · testes em
> [`test/e2e/`](../../test/e2e/)

---

## 🎯 Objetivo

Aplicar as proteções que **toda API profissional** precisa, guiadas pelo **OWASP Top 10**: headers seguros, CORS
restrito, rate limit, validação de entrada, senhas com hash, JWT, **autorização por recurso** e configuração segura.

**Por que importa:** a maioria dos incidentes reais não vem de criptografia quebrada, e sim de **controle de acesso
esquecido**, configuração errada e entrada não validada. Foi exatamente o que aconteceu neste projeto: as rotas de
tarefas ficaram **sem autenticação nenhuma** até a correção descrita na Parte 5.

---

## 🧠 O OWASP Top 10

A **OWASP** (*Open Worldwide Application Security Project*) publica a lista das categorias de risco mais críticas
em aplicações web. Este módulo usa a numeração da edição **2021**, a mesma citada nos comentários do código.

> A edição **2025** reorganizou a lista (por exemplo, *Security Misconfiguration* subiu de posição e entrou uma
> categoria dedicada a falhas na **cadeia de suprimentos de software**). Os conceitos abaixo continuam valendo;
> muda a ordem e o agrupamento.

### Cobertura no TaskFlow

| # | Categoria | Status | Onde |
|---|---|:-:|---|
| A01 | **Broken Access Control** | ✅ | JWT em todas as rotas de domínio, `assertOwner`, anti-IDOR, 404 anti-enumeração ([Parte 5](#-parte-5--autorização-por-recurso-owasp-a01)) |
| A02 | Cryptographic Failures | ✅ | bcrypt custo 10, JWT `HS256` com segredo ≥ 32 caracteres |
| A03 | Injection | ✅ | Prisma parametriza tudo; DTOs com `whitelist`; nenhum SQL com entrada concatenada |
| A04 | Insecure Design | ✅ | Rate limit, teto de paginação (100), regras de negócio no agregado |
| A05 | Security Misconfiguration | ✅ | Helmet, CORS explícito, *fail-fast* de configuração, Swagger desligado em produção |
| A06 | Vulnerable Components | 🟡 | `npm ci` com lockfile; **sem** `npm audit`/Dependabot no CI |
| A07 | Identification & Auth Failures | 🟡 | Mesma mensagem **e mesmo tempo** para erro de login (anti timing attack), throttle; sem refresh token ([Limitações](#-limitações-e-próximos-passos)) |
| A08 | Software & Data Integrity | 🟡 | CI com `permissions: contents: read`; actions fixadas por tag, não por SHA |
| A09 | Logging & Monitoring Failures | 🟡 | Traces e métricas (Módulo 01); eventos de segurança (login falho, 403, 429) **não** são logados |
| A10 | SSRF | ➖ | Não se aplica: a API não faz requisições a URLs fornecidas pelo usuário |

### Equivalência com AWS

| Categoria | Serviço AWS relacionado |
|---|---|
| A01 Access Control | IAM (policies, roles), Cognito (grupos) |
| A02 Criptografia | KMS, ACM, Secrets Manager |
| A03 Injection · A04 Design | WAF (regras de SQL injection, *rate-based rules*), Shield |
| A05 Configuração | Security Hub, Config, Trusted Advisor |
| A06 Componentes | Amazon Inspector, ECR scanning |
| A07 Autenticação | Cognito, IAM, STS |
| A09 Logging | CloudTrail, GuardDuty, Security Hub |

> Em produção na AWS, o **Cognito** substituiria o bcrypt + JWT feitos à mão (hash, rotação de tokens, refresh,
> MFA). Implementar por baixo é o que ensina **por que** cada peça existe.

---

## 🛠️ Parte 1 — Headers, CORS e rate limit

Tudo é configurado em [`configureApp()`](../../src/app.setup.ts), a **mesma** função usada pelo `main.ts` e pelos
testes E2E. Assim, os testes validam a configuração real, e não uma cópia.

### Helmet (A05)

```ts
app.use(helmet());
```

| Header | Previne |
|---|---|
| `X-Frame-Options` | Clickjacking (sua página dentro de um `iframe` malicioso) |
| `X-Content-Type-Options: nosniff` | O navegador "adivinhar" o tipo de um arquivo |
| `Strict-Transport-Security` | Downgrade de HTTPS para HTTP |
| `Content-Security-Policy` | Execução de scripts não autorizados (XSS) |
| `Referrer-Policy` | Vazamento da URL de origem |

Uma linha, ~15 headers: é a proteção mais barata que existe.

### CORS (A05)

```ts
app.enableCors({
  origin: config.get('CORS_ORIGINS', { infer: true }), // lista vinda do ambiente, validada como URLs
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
});
```

Com `origin: '*'`, qualquer site poderia chamar a API **com a sessão do usuário logado**. As origens permitidas são
uma **lista explícita**, configurada por ambiente (`CORS_ORIGINS=http://localhost:5173,https://taskflow.app`), e não
fixa no código.

### Rate limit (A04)

```ts
// app.module.ts — limite global, sempre registrado
ThrottlerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => ({
    throttlers: [{ ttl: 60_000, limit: 100 }],             // 100 req/min por IP
    skipIf: () => config.get('DISABLE_THROTTLE', { infer: true }), // só testes e carga
  }),
}),

// auth.controller.ts — mais rígido onde há brute force
@Post('register') @Throttle({ default: { limit: 3, ttl: 60_000 } })
@Post('login')    @Throttle({ default: { limit: 5, ttl: 60_000 } })
```

O guard é **sempre** registrado e decide em runtime se pula (`skipIf`). Assim, a estrutura da aplicação é a mesma
em teste e em produção.

---

## 🛠️ Parte 2 — Validação de entrada (A03)

```ts
new ValidationPipe({
  whitelist: true,             // remove campos não declarados no DTO
  forbidNonWhitelisted: true,  // e responde 400 se vierem
  transform: true,
  transformOptions: { enableImplicitConversion: true },
});
```

**Mass assignment:** sem `whitelist`, um cliente poderia enviar `{ "title": "X", "ownerId": "outro-usuário" }` e
sobrescrever campos internos. Com a configuração acima, a resposta é `400 property ownerId should not exist`.

**Toda** entrada é validada, e não só o body:

| Entrada | Validação |
|---|---|
| Body | DTOs com `class-validator` (`@IsEmail`, `@MinLength`, `@IsUUID`, `@IsIn`…) |
| Parâmetros de rota | `ParseUUIDPipe({ version: '4' })`: `/projects/abc` é `400` antes de tocar no banco |
| Query string | `CursorPaginationDto` com `@Max(100)`: o servidor impõe o teto (OWASP API4, consumo de recursos) |
| Variáveis de ambiente | Schema `zod` no boot (Parte 6) |
| Banco | Enums do PostgreSQL recusam valores fora do domínio, mesmo via SQL direto |

---

## 🛠️ Parte 3 — Senhas com bcrypt (A02)

**Hash ≠ criptografia:** criptografia é reversível (serve para dados que precisam ser lidos de volta); hash é de mão
única (serve para **verificar** sem guardar o original).

```ts
const hash = await bcrypt.hash(password, 10);       // no cadastro
const ok = await bcrypt.compare(password, hash);    // no login
```

```text
$2b$10$AnhKio5jpvRYGExcwBXLFOrX.8cYykm0tQMFW.8aRokYfQcGXnaga
│  │  │└─ salt (22 caracteres) + hash
│  │  └── custo: 2^10 iterações
│  └───── algoritmo (bcrypt 2b)
```

- **Lento por design:** torna o ataque de força bruta offline caro.
- **Salt embutido:** a mesma senha gera hashes diferentes (inutiliza *rainbow tables*).
- **Limite de 72 bytes:** o bcrypt **ignora** o que vem depois do 72º byte. Por isso o `RegisterDto` tem `@MaxLength(72)`, sem o qual uma senha de 100 caracteres daria uma falsa sensação de segurança.

> **Desempenho:** o bcrypt roda no *thread pool* do libuv (4 threads por padrão). Sob carga, o cadastro e o login
> disputam essas threads, um efeito medido no Módulo 11.

---

## 🛠️ Parte 4 — Autenticação com JWT (A02, A07)

```text
eyJhbGciOiJIUzI1NiJ9 . eyJzdWIiOiJ1MSIsImVtYWlsIjoi… . assinatura
      header                     payload                 HMAC-SHA256
```

O payload é **público** (é só Base64): qualquer um decodifica. O que garante a autenticidade é a **assinatura**, que
só quem tem o `JWT_SECRET` consegue gerar.

**Fluxo:** `POST /auth/register` (hash) → `POST /auth/login` (compara, emite o token) → as rotas seguintes enviam
`Authorization: Bearer <token>` → o `JwtStrategy` valida a assinatura e a expiração e popula `request.user`.

| Proteção | Implementação |
|---|---|
| Segredo forte | `JWT_SECRET` com **≥ 32 caracteres**, validado no boot (a app não sobe sem ele) |
| Expiração | `JWT_EXPIRES_IN` (padrão `1h`), formato validado por regex; `ignoreExpiration: false` |
| Algoritmo fixo | `algorithm: 'HS256'` ao assinar **e** `algorithms: ['HS256']` ao verificar: bloqueia o ataque de *algorithm confusion* (`alg: none` ou troca de algoritmo) |
| Mesma mensagem | `Credenciais inválidas` para "usuário não existe" **e** "senha errada" (anti-enumeração de usuários) |
| Mesmo tempo | O `bcrypt.compare` roda **sempre**: contra um hash fictício (`DUMMY_PASSWORD_HASH`, mesmo custo do cadastro) quando o e-mail não existe. Sem isso, o tempo de resposta (~1 ms × ~60–100 ms) revelaria o cadastro (*timing attack*) |
| Usuário tipado | `@CurrentUser()` devolve `AuthenticatedUser`, e não `any` |

---

## 🛠️ Parte 5 — Autorização por recurso (OWASP A01)

Autenticação responde "**quem** é você?". Autorização responde "**você pode** mexer **neste** recurso?". Foi aqui
que o projeto falhou: até o Bloco 3 de correções, `POST` e `GET /projects/:id/tasks` **não tinham guard nenhum**.
Qualquer pessoa, sem token, criava e lia tarefas de qualquer projeto.

### O que foi implementado

**1. Posse modelada no banco:** `Project.ownerId` (FK para `User`). Não dá para autorizar o que não se modela.

**2. Guard na classe do controller** (*secure by default*): nenhuma rota nova nasce pública por esquecimento.

```ts
@Controller('projects/:projectId/tasks')
@UseGuards(JwtAuthGuard)
export class TasksController { /* ... */ }
```

**3. Um único ponto de verificação**, com uma única query:

```ts
// projects.service.ts
async findOwned(projectId: string, userId: string) {
  const project = await this.prisma.project.findFirst({
    where: { id: projectId, ownerId: userId },   // id E dono na MESMA consulta
    select: projectSelect,
  });
  if (!project) throw new NotFoundException('Projeto não encontrado');
  return project;
}
```

**4. `404`, e não `403`, para recurso de outro usuário.** Um `403` confirmaria que o projeto **existe**. Com `404`,
"é de outra pessoa" e "não existe" são indistinguíveis (anti-enumeração), o mesmo comportamento de GitHub e S3.

**5. `userId` sempre do token, nunca do body.** Se o cliente pudesse mandar o próprio `userId`, poderia mandar o de
outra pessoa (**IDOR**, *Insecure Direct Object Reference*).

**6. Anti-IDOR em rotas aninhadas.** Em `PATCH /projects/A/tasks/X`, verificar só o projeto A não basta: a tarefa X
pode pertencer a **outro** projeto do mesmo usuário. O roteiro dos comandos confere as duas coisas:

```ts
// task-command.runner.ts
await this.projects.assertOwner(target.projectId, target.userId);
const task = await this.repository.load(target.taskId);
if (!task || task.projectId !== target.projectId) {
  throw new NotFoundException('Tarefa não encontrada');   // o MESMO 404
}
```

**7. Autorização antes de qualquer efeito.** Num Event Store *append-only*, um evento gravado indevidamente **nunca
mais sai**. Por isso a verificação vem **antes** do `append`, e um teste prova que, sem permissão, **zero eventos**
são gravados.

**8. Exposição mínima de dados** (OWASP API3): as respostas usam `select` explícito; o `ownerId` e a senha nunca saem
na resposta.

---

## 🛠️ Parte 6 — Configuração segura (A05)

Todas as variáveis de ambiente passam por um schema `zod` ([`env.schema.ts`](../../src/config/env.schema.ts)) **no
boot**. Se algo estiver errado, a aplicação **se recusa a subir**, listando todos os erros de uma vez:

| Regra | Por quê |
|---|---|
| `DATABASE_URL` e `JWT_SECRET` **obrigatórios, sem default** | Um default para segredo é uma vulnerabilidade esperando acontecer |
| `JWT_SECRET` com ≥ 32 caracteres | Segredo curto é quebrável por força bruta |
| `DATABASE_URL` precisa ser `postgres(ql)://` | Pega a URL errada colada por engano |
| `CORS_ORIGINS` validada como lista de URLs | Uma origem malformada não passa silenciosamente |

Outras decisões de configuração:
- **Swagger desligado em produção:** a documentação interativa entregaria o mapa da API a quem quisesse atacar.
- **`.env` no `.gitignore`**, com um `.env.example` documentado: segredo nunca vai para o repositório.

---

## 🧪 Como está provado

| Cenário | Resultado | Teste |
|---|---|---|
| Registro / login / `GET /auth/me` com token válido | 201 / 200 / 200 | [`auth.e2e-spec.ts`](../../test/e2e/auth.e2e-spec.ts) |
| Sem token, token falso, header malformado | 401 | idem |
| E-mail inválido, senha curta, campo extra (`isAdmin`) | 400 | idem |
| Mesma mensagem para usuário inexistente e senha errada | ✔ | [`auth.service.spec.ts`](../../test/unit/auth.service.spec.ts) |
| Usuário inexistente também paga o `bcrypt.compare` (hash fictício de mesmo custo), sem atalho de login por ele | ✔ | idem |
| Rotas de tarefa sem token | 401 | [`tasks.e2e-spec.ts`](../../test/e2e/tasks.e2e-spec.ts) |
| Intruso lista/cria/lê histórico em projeto alheio | 404, e **0 eventos gravados** | idem |
| Tarefa do projeto A alterada pela URL do projeto B (mesmo dono) | 404 | idem |
| `projectId` inválido · `limit=500` · campo extra no body | 400 | idem |
| Configuração inválida (segredo curto, URL errada, porta inválida) | A app não sobe | [`env.schema.spec.ts`](../../test/unit/env.schema.spec.ts) |
| A query de posse filtra por `id` **e** `ownerId` | ✔ | [`projects.service.spec.ts`](../../test/unit/projects.service.spec.ts) |

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | **Rotas de tarefa abertas** a qualquer pessoa | Guard aplicado só no `/auth/me`; autorização por recurso ficou como "próximo passo" | Guard na classe + `assertOwner` + anti-IDOR |
| 2 | CORS liberava `localhost:3001`, a porta do **Grafana** | Comentário "frontend local" desatualizado | `CORS_ORIGINS` por ambiente (padrão: `localhost:5173`, do Vite) |
| 3 | Um clone novo não subia: `JwtStrategy requires a secret or key` | `.env.example` sem `JWT_SECRET`; o `!` escondia o problema | Schema `zod` com segredo obrigatório |
| 4 | O E2E testava uma configuração diferente da produção | O teste montava Helmet e `ValidationPipe` à mão, sem CORS | `configureApp()` compartilhado |
| 5 | Teste com `JWT_SECRET = 'test-secret'` passou a falhar | O schema agora exige ≥ 32 caracteres | Segredo de teste com o tamanho mínimo (o teste estava errado, não a regra) |
| 6 | **Timing attack** no login: e-mail inexistente respondia em ~1 ms, existente em ~60–100 ms | O `bcrypt.compare` só rodava se o usuário existisse, e um teste unitário **afirmava** isso ("não perde tempo comparando"): o teste protegia a vulnerabilidade | `compare` sempre, contra um hash fictício de mesmo custo; o teste passou a exigir o contrário |
| 7 | `POST /auth/login` respondia `201 Created` | Padrão do NestJS para todo `POST`, mas o login não cria recurso | `@HttpCode(200)`, com Swagger e E2E ajustados |

---

## 🚧 Limitações e próximos passos

- **Sem refresh token nem revogação:** um token roubado vale até expirar (1 h).
- **Eventos de segurança não logados (A09):** login falho, 404 de autorização e 429 deveriam gerar log estruturado com IP e `correlationId`.
- **Componentes vulneráveis (A06):** o `npm install` reporta vulnerabilidades em dependências transitivas; faltam `npm audit` no CI e Dependabot.
- **Rate limit em memória:** não é compartilhado entre réplicas (em produção, *storage* em Redis).

---

## ✅ Checklist

- [x] Helmet, CORS por ambiente e rate limit (global + por rota)
- [x] Validação de body, parâmetros, query e ambiente
- [x] bcrypt custo 10, com limite de 72 bytes respeitado
- [x] JWT com segredo forte, expiração e algoritmo fixo
- [x] Autorização por dono do projeto, 404 anti-enumeração, anti-IDOR, `userId` só do token
- [x] *Fail-fast* de configuração e Swagger desligado em produção
- [x] Cenários de segurança cobertos por testes E2E
- [x] Login com mesma mensagem e mesmo tempo (anti-enumeração e anti timing attack)
- [ ] Refresh token, logs de segurança, `npm audit`/Dependabot

---

**Anterior:** [Módulo 05 — Event Sourcing e CQRS](05-event-sourcing-cqrs.md) ·
**Próximo:** [Módulo 07 — Testes](07-testes.md)
