# Módulo 12 — Design Patterns

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** [`src/modules/tasks/`](../../src/modules/tasks/) (Strategy, Repository, Adapter,
> Template Method, Factory Method, Observer) · decorators do NestJS em todo o `src/`

---

## 🎯 Objetivo

Reconhecer os padrões de projeto mais usados em backend, **saber onde cada um está (ou não está) no código** e,
principalmente, entender **que problema** cada um resolve. Padrão aplicado sem problema para resolver é só cerimônia.

**Por que importa:** padrões dão um vocabulário comum ("isso é um Strategy", "aqui cabe um Repository"). Mas o que
diferencia quem domina é saber **o custo** de cada um e conseguir apontar **onde ele está de verdade** num código.

---

## 🧠 O que são design patterns

Soluções recorrentes para problemas recorrentes de design, catalogadas em 1994 pelo *Gang of Four* (GoF) em três
famílias:

| Família | Pergunta que responde | Exemplos |
|---|---|---|
| **Criacionais** | Como criar objetos? | Factory Method, Abstract Factory, Builder, Singleton |
| **Estruturais** | Como compor objetos? | Adapter, Decorator, Facade, Proxy |
| **Comportamentais** | Como objetos colaboram? | Strategy, Observer, Template Method, Command |

Padrões arquiteturais como **Repository** vêm de outras fontes (Martin Fowler, DDD), mas são estudados juntos.

---

## 🗺️ Mapa: onde cada padrão está no TaskFlow

| Padrão | Família | Status | Onde |
|---|---|:-:|---|
| **Repository** | Arquitetural | ✅ | [`TaskRepository`](../../src/modules/tasks/domain/task.repository.ts) → [`EventSourcedTaskRepository`](../../src/modules/tasks/infrastructure/event-sourced-task.repository.ts) |
| **Adapter** | Estrutural | ✅ | O `EventSourcedTaskRepository` adapta o Event Store à porta que o domínio espera |
| **Template Method** | Comportamental | ✅ | [`TaskCommandRunner`](../../src/modules/tasks/commands/task-command.runner.ts) (forma funcional) |
| **Observer** | Comportamental | ✅ | `EventBus` do `@nestjs/cqrs` → projeções (`@EventsHandler`) |
| **Command** | Comportamental | ✅ | Commands do CQRS (`AssignTaskCommand`…) despachados pelo `CommandBus` |
| **Factory Method** | Criacional | ✅ | `TaskAggregate.fromHistory()`, `toBusEvent()`, `useFactory` dos módulos Nest |
| **Strategy** | Comportamental | 🟡 | [`task-priority.strategy.ts`](../../src/modules/tasks/strategies/task-priority.strategy.ts): interface certa, composição parcial |
| **Decorator** | Estrutural | 🟡 | Decorators do TypeScript/NestJS: parentes do GoF, mas não o mesmo padrão |
| **Singleton** | Criacional | ✅ (implícito) | Providers do NestJS são singletons por padrão |
| Abstract Factory, Builder, Facade, Proxy | — | ❌ | Estudados; sem aplicação no projeto |

---

## 1. Repository + Adapter

**Problema:** sem eles, a lógica de negócio fica acoplada à tecnologia de persistência. Trocar de banco, ou testar
sem banco, vira uma reescrita.

**Solução:** o domínio define o **contrato** do que precisa (a *porta*); a infraestrutura o **implementa** (o
*adaptador*).

```ts
// domain/task.repository.ts — o contrato. abstract class (e não interface) porque existe em runtime
// e serve também de TOKEN de injeção do NestJS.
export abstract class TaskRepository {
  abstract load(taskId: string): Promise<TaskAggregate | null>;
  abstract save(task: TaskAggregate): Promise<TaskDomainEvent[]>;
}

// tasks.module.ts — quem pede o contrato recebe a implementação
{ provide: TaskRepository, useClass: EventSourcedTaskRepository }
```

O `EventSourcedTaskRepository` é ao mesmo tempo um **Repository** (do ponto de vista do domínio) e um **Adapter**:
converte "carregar uma tarefa" em "ler o stream de eventos e reidratar o agregado", e "salvar" em "gravar os eventos
pendentes com concorrência otimista".

**Ganho concreto:** os handlers dependem de `TaskRepository`, e não do Prisma. Nos testes, um objeto simples faz o
papel do repositório; se o Event Store migrasse para outro banco, só o adaptador mudaria.

**Custo:** uma camada a mais. Por isso os projetos e usuários, que são CRUD simples, **não** usam: o
`ProjectsService` fala direto com o Prisma, e está tudo bem.

---

## 2. Template Method (forma funcional)

**Problema:** três comandos (atribuir, mudar status, concluir) seguiam **o mesmo roteiro**: autorizar, carregar,
aplicar a regra, salvar e publicar. Mudava só a regra. Copiar o roteiro três vezes significaria três lugares para
esquecer a autorização.

**Solução clássica (GoF):** uma classe base com o algoritmo fixo e um "passo" abstrato que as subclasses
implementam. **Aqui, a forma funcional:** o passo variável é passado como função.

```ts
// O esqueleto, escrito e testado UMA vez
async run(target: TaskCommandTarget, mutate: (task: TaskAggregate) => void) {
  await this.projects.assertOwner(target.projectId, target.userId);  // 1. autoriza
  const task = await this.repository.load(target.taskId);            // 2. carrega (+ anti-IDOR)
  mutate(task);                                                      // 3. o passo variável
  const saved = await this.repository.save(task);                   // 4. persiste
  saved.forEach((e) => this.eventBus.publish(toBusEvent(e)));        // 5. publica
}

// Cada handler só informa o passo variável
execute({ target, assigneeId }: AssignTaskCommand) {
  return this.runner.run(target, (task) => task.assign(assigneeId));
}
```

**Por que funcional, e não herança:** sem hierarquia de classes, o handler não herda nada que não precise, e o teste
do runner é independente do teste de cada handler.

---

## 3. Observer

**Problema:** quando uma tarefa muda, várias coisas precisam reagir (hoje, o Read Model; amanhã, talvez
notificações e integrações) sem que o comando conheça cada uma delas.

**Solução:** o comando **publica** um evento; quem se interessa se **inscreve**.

```ts
this.eventBus.publish(new TaskCompletedEvent({ taskId, completedAt }));   // quem publica não sabe quem escuta

@EventsHandler(TaskCompletedEvent)                                        // quem escuta não sabe quem publicou
export class TaskCompletedProjection implements IEventHandler<TaskCompletedEvent> { /* ... */ }
```

Adicionar uma reação nova é criar um handler novo, **sem tocar no comando**: o princípio aberto/fechado na prática.
Na AWS, o equivalente é SNS/EventBridge com assinantes (Módulo 05).

---

## 4. Command

Cada intenção de mudança vira um **objeto** (`AssignTaskCommand`, `CompleteTaskCommand`), despachado por um
`CommandBus` até o handler certo. Isso desacopla **quem pede** (o controller) de **quem executa** (o handler), e
permite tratar comandos como dados: enfileirar, registrar, validar.

Os construtores usam **objetos nomeados** (`target: { userId, projectId, taskId }`), e não vários `string`
posicionais: um bug real deste projeto gravou a prioridade no lugar do título por causa de argumentos trocados.

---

## 5. Factory Method

**Problema:** criar um objeto exige lógica (validar, montar a partir de dados), e espalhar essa lógica pelos
chamadores duplica regras.

O exemplo clássico da literatura é uma `ClientFactory.create('banco-x')` que escolhe o cliente HTTP de cada parceiro.
O TaskFlow não tem integrações externas, então essa forma **não existe aqui**. Mas o padrão aparece em três lugares:

| Onde | Forma | Por quê |
|---|---|---|
| `TaskAggregate.fromHistory(eventos)` | *Static factory method* | O construtor é **privado**: a única forma de obter um agregado é reconstruí-lo do histórico, já validando que ele começa com `TaskCreated` |
| `toBusEvent(eventoDeDomínio)` | Função fábrica | Escolhe a **classe** certa de evento a partir do `type`, com um `switch` exaustivo (`never`) |
| `JwtModule.registerAsync({ useFactory })` | *Factory provider* do Nest | O objeto de configuração é **criado na hora da injeção**, já com o `ConfigService` validado |

---

## 6. Strategy

**Problema:** várias formas de calcular a mesma coisa (aqui, a prioridade de uma tarefa) sem uma cadeia de `if/else`.

```ts
export interface TaskPriorityStrategy {
  calculate(title: string, dueDate?: Date): 'LOW' | 'MEDIUM' | 'HIGH';
}

export class KeywordPriorityStrategy implements TaskPriorityStrategy { /* "urgente", "bug", "crítico" → HIGH */ }
export class DeadlinePriorityStrategy implements TaskPriorityStrategy { /* prazo ≤ 1 dia → HIGH */ }
```

**Funciona:** um título com "bug" ou "urgente" gera `priority: 'HIGH'` no evento, e isso chega ao Read Model.

**Mas está pela metade**, e vale entender por quê:

| Aspecto | Hoje | O padrão completo |
|---|---|---|
| Composição | `private priorityStrategy = new KeywordPriorityStrategy()` dentro do handler | A estratégia **injetada** (ex.: `{ provide: TASK_PRIORITY_STRATEGY, useClass: … }`) |
| Troca em runtime | Impossível sem editar o handler | Trocar o provider (ou escolher por configuração) |
| Segunda estratégia | `DeadlinePriorityStrategy` **existe e nunca é usada** | Selecionada por regra ou combinada (ex.: a maior das duas prioridades) |
| Testes | Nenhum teste próprio das estratégias | Um teste por estratégia, independente do handler |

> **A lição:** ter a interface e duas implementações **não** é o padrão. O valor do Strategy está em **trocar** o
> algoritmo sem mexer em quem o usa, e aqui quem usa escolhe a implementação com `new`.

**Detalhe de domínio:** a busca por `'crítico'` (com acento) não encontra "critico" sem acento; normalizar o texto
(remover acentos antes de comparar) tornaria a estratégia mais robusta.

---

## 7. Decorator (e a diferença para os decorators do TypeScript)

O **Decorator do GoF** *embrulha* um objeto para adicionar comportamento mantendo a mesma interface (ex.: um
`LoggingRepository` que envolve outro repositório e registra cada chamada).

Os **decorators do TypeScript/NestJS** (`@UseGuards`, `@Throttle`, `@Controller`, `@CurrentUser`) são outra coisa:
**anotações** que gravam metadados lidos pelo framework. O efeito é parecido, pois adicionam comportamento sem alterar
a lógica do método:

```ts
@Controller('projects/:projectId/tasks')
@UseGuards(JwtAuthGuard)        // autenticação em TODAS as rotas, sem uma linha no corpo dos métodos
export class TasksController { /* ... */ }
```

Mas o mecanismo é de **metaprogramação/AOP**, e não de composição de objetos. Saber essa diferença evita a frase
imprecisa "uso o Decorator Pattern porque uso `@UseGuards`".

---

## 8. Singleton

Por padrão, cada provider do NestJS é instanciado **uma vez** e compartilhado (`PrismaService`, `EventStoreService`):
o container de injeção de dependência faz o papel do Singleton, **sem** os problemas da versão clássica (estado
global, difícil de testar). Nos testes, o mesmo container permite trocar a instância por um mock.

---

## 🎯 Quando usar cada um

| Sintoma no código | Padrão que costuma resolver |
|---|---|
| `if/else` ou `switch` crescendo com "formas de fazer X" | Strategy |
| Lógica de negócio importando o ORM | Repository (+ Adapter) |
| O mesmo roteiro copiado em vários lugares, mudando um passo | Template Method |
| Uma ação precisa disparar reações que ela não deveria conhecer | Observer |
| Criação de objetos com regras espalhadas pelos chamadores | Factory Method |
| Comportamento transversal (auth, log, cache) repetido em métodos | Decorator / AOP |

E o contrário: **não** aplique um padrão sem o sintoma. Os módulos de projetos e de usuários são CRUD simples, e
continuam sem Repository nem Event Sourcing de propósito.

---

## ⚠️ Problemas encontrados e correções

| # | Problema | Situação |
|---:|---|---|
| 1 | A primeira versão deste módulo apresentava `PrismaTasksRepository` e `BankClientFactory` como parte do TaskFlow, mas eles **não existiam** | Corrigido: o Repository foi implementado de verdade (Módulo 05); a Factory é apresentada como exemplo da literatura |
| 2 | Dizia que a estratégia era **injetada**; ela é instanciada com `new` | Documentado como limitação |
| 3 | `DeadlinePriorityStrategy` sem uso e sem teste | Documentado como limitação |
| 4 | Citava `@UseGuards` protegendo as rotas de tarefas quando elas ainda estavam **abertas** | Verdade hoje (Módulo 06) |
| 5 | Argumentos posicionais trocados gravaram a prioridade no lugar do título | Commands e eventos com parâmetros nomeados |

---

## ✅ Checklist

- [x] As três famílias do GoF e onde o Repository se encaixa
- [x] Repository + Adapter implementados e usados
- [x] Template Method (funcional) centralizando o roteiro dos comandos
- [x] Observer e Command via `@nestjs/cqrs`
- [x] Factory Method em três formas reais no código
- [x] Diferença entre Decorator (GoF) e decorators do TypeScript
- [ ] Strategy completo: injeção, seleção da estratégia e testes próprios
- [ ] Normalização de acentos na `KeywordPriorityStrategy`

---

**Anterior:** [Módulo 11 — Node.js internals](11-nodejs-internals.md) ·
**Índice:** [Trilha de estudos](README.md)
