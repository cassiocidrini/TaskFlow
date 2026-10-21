---
name: taskflow-docs
description: Padrão de documentação do TaskFlow (NestJS + CQRS + Event Sourcing) — TSDoc em português explicando o porquê e Swagger fiel ao comportamento real. Use sempre que for documentar, comentar ou revisar comentários em qualquer arquivo de src/, test/, terraform/, scripts/, load/ ou labs/ deste repositório, criar/alterar um endpoint ou DTO (o Swagger faz parte da tarefa, não é opcional), adicionar um evento/comando novo, ou quando o usuário pedir "documente", "TSDoc", "Swagger", "OpenAPI" ou "comente o código".
---

# Documentação no TaskFlow

Este é o padrão aplicado em todo o `src/`, `test/`, `terraform/`, `scripts/`, `load/` e `labs/`. Ele especializa a skill
genérica `senior-code-docs` — se ela estiver disponível, os princípios gerais estão lá; o que vale AQUI está abaixo.

**Antes de escrever qualquer comentário, leia o [AGENTS.md](../../../AGENTS.md)** — em especial "Padrões aplicados",
"NÃO FAÇA" e "Ainda NÃO implementado". Comentário que afirma algo que o AGENTS.md lista como não implementado é bug.

## Regras do projeto

1. **Idioma:** português, termos técnicos no original (CQRS, Event Sourcing, thread pool, race condition).
2. **Sintaxe:** `/** */` em declarações; `/* */` para cabeçalho de arquivo com várias declarações
   (ex.: `task.events.ts`, `task.responses.ts`); `//` só para o porquê de uma linha. Terraform: `#`.
3. **O porquê, não o quê.** Comentários "passo 1, passo 2" são removidos quando o arquivo é tocado.
4. **Nomeie o que o código É:** CQRS, Event Sourcing, Repository + Adapter (`TaskRepository` → `EventSourcedTaskRepository`),
   Template Method (`TaskCommandRunner`), Strategy (parcial — ver limitações), concorrência otimista
   (`UNIQUE (aggregate_id, version)`), idempotência das projeções (`skipDuplicates` / `updateMany`), consistência eventual.
5. **Segurança com OWASP:** A01 (guard na classe, `assertOwner` em uma query só com `id` + `ownerId`, 404 e não 403,
   anti-IDOR do `projectId` da tarefa, `userId` só do JWT), A02/A07 (bcrypt, HS256 fixo, segredo ≥ 32), A05 (Helmet,
   CORS, Swagger fora de produção), API4 (`limit` ≤ 100, throttler).
6. **Limitações conhecidas ficam documentadas ao lado do código, não escondidas.** As atuais (mantenha coerente com o
   README e `docs/modules/`): Strategy com `new` e `DeadlinePriorityStrategy` sem uso; dual-write sem outbox;
   throttler em memória; state do Terraform sem lock; Jaeger v1 descontinuado; sem health check nem graceful
   shutdown; Dockerfile em `node:20` e como root. Ao corrigir uma, tire-a daqui no MESMO PR.

## Swagger — como está montado

- `src/app.setup.ts` (`setupSwagger`): `addBearerAuth` + 4 tags descritas (`auth`, `projects`, `tasks`, `app`) + legenda
  de status. **Sem** `addSecurityRequirements` global — register/login são públicos.
- Toda rota nova: `@ApiTags` com um dos 4 nomes, `@ApiOperation` (summary + description para o consumidor),
  `@ApiResponse` só com status reais, `@ApiBearerAuth()` se protegida (os controllers protegidos já têm na classe).
- Respostas tipadas por **classes de documentação**: `auth/dto/auth.responses.ts`, `projects/dto/project.response.ts`,
  `tasks/dto/task.responses.ts`. Handler novo que devolve interface → adicione a classe correspondente lá.
- `tasks.controller.ts` já tem blocos prontos — reutilize: `ProjectIdParam()`, `TaskIdParam()`, `CommonTaskErrors()`
  (400/401/404), `LifecycleConflict()` (409), e o pipe `UUID_V4`.
- Status deste projeto: POST = 201 (inclusive login); 400 = `ValidationPipe`/`ParseUUIDPipe`; 401 = `JwtAuthGuard`;
  404 = projeto/tarefa inexistente OU de outro usuário; 409 = `ConflictException`/`ConcurrencyConflictError`/regra do
  ciclo de vida; 429 = só em register (3/min) e login (5/min), que têm `@Throttle` próprio.
- DTOs: `@ApiProperty`/`@ApiPropertyOptional` com `description` + `example`, repetindo os limites do class-validator.

## Ao adicionar um evento ou comando (receitas do AGENTS.md)

Os "5 lugares" do evento também ganham documentação: a interface `Data` (o contrato persistido — mudar quebra o
histórico) e a classe `Event` em `task.events.ts`; o `apply` do agregado; a projeção (por que é idempotente); e a
rota no Swagger com o 409 se a transição puder ser recusada.

## Testes

Todo arquivo em `test/` abre com um bloco dizendo **que propriedade do sistema a suíte protege** e por que foi escrita
assim (banco real via Testcontainers, `eventually()` para consistência eventual, dono × intruso nos E2E).

## Verificação (rode e relate os números)

```bash
npx tsc --noEmit && npm run lint && npm run test:unit
npm run build                                     # aplica o plugin do Swagger (nest-cli.json)
node .claude/skills/taskflow-docs/scripts/probe-openapi.js            # 13 rotas, 4 tags, sem tag fantasma
node .claude/skills/taskflow-docs/scripts/find-undocumented.js src test terraform scripts load labs   # esperado: 0
npm run test:e2e        # se tocou em controller/pipe/guard (Docker ligado; roda com --runInBand)
```

Terraform (só comentários mudaram?): `terraform -chdir=terraform fmt -check` e `validate` após `init -backend=false`.
Não comente `terraform/.terraform.lock.hcl` (gerado) nem nada em `prisma/migrations/` já aplicado.
