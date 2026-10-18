# Módulo 04 — Modelagem NoSQL com DynamoDB

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** [`src/dynamo/`](../../src/dynamo/) (scripts de estudo executados via `npm run dynamo:*`) ·
> LocalStack no [`docker-compose.yml`](../../docker-compose.yml)
>
> ℹ️ **Escopo:** este módulo é um **laboratório de modelagem**. A API do TaskFlow persiste em PostgreSQL; os
> scripts em `src/dynamo/` modelam o **mesmo domínio** (usuários, projetos, tarefas) em DynamoDB para comparar
> as duas abordagens.

---

## 🎯 Objetivo

Aprender a modelar dados no **DynamoDB** com **query-first design**, praticando **Partition Key + Sort Key**,
**GSI** e **Single-Table Design**, e entender **quando** um banco NoSQL faz sentido em vez de um relacional.

**Por que importa:** escolher o banco é uma das decisões de arquitetura mais caras de reverter. Saber modelar
NoSQL e, principalmente, saber **quando não usar**, é o que diferencia uma escolha técnica de uma escolha por moda.

---

## 🧠 Conceitos

### A mudança de mentalidade

| Aspecto | PostgreSQL (SQL) | DynamoDB (NoSQL) |
|---|---|---|
| Ponto de partida | "Quais são minhas entidades?" | "Quais **perguntas** o app vai fazer?" |
| Modelagem | Normalizar, evitar redundância | Desnormalizar, duplicar para ler rápido |
| Consultas | Qualquer `JOIN`, qualquer `WHERE` | Só o que a **chave** permite |
| Escala | Vertical (máquina maior) | Horizontal (mais partições), automática |
| Consistência | ACID | Eventual por padrão (forte sob demanda, com custo) |
| Custo | Servidor sempre ligado | Por requisição (*on-demand*) ou capacidade provisionada |

### Query-first design

No SQL você modela e **depois** escreve as consultas. No DynamoDB, primeiro se listam os **padrões de acesso**
e só então se desenham as chaves.

> **Regra de ouro:** se uma pergunta do app não pode ser respondida com **uma** `Query` (ou um `GetItem`), o modelo está errado.

### Partition Key + Sort Key

- **Partition Key (PK):** decide em qual **partição física** o item mora. Obrigatória.
- **Sort Key (SK):** ordena os itens **dentro** da partição. Opcional, mas é onde mora o poder do modelo.

Por isso a SK das tarefas é `TASK#<createdAt>#<taskId>`, e não só `TASK#<taskId>`:

1. **Ordenação cronológica** grátis, sem `ORDER BY`;
2. **Range queries**: tarefas criadas entre X e Y;
3. **As N mais recentes**: `Limit: N` + `ScanIndexForward: false`;
4. **Desempate**: duas tarefas no mesmo instante continuam com chaves únicas pelo `taskId`.

> 🔗 É o mesmo raciocínio da ordenação `createdAt DESC, id DESC` da listagem paginada da API
> ([`get-tasks.handler.ts`](../../src/modules/tasks/queries/get-tasks.handler.ts)): sem um desempate, a paginação
> pula ou repete itens.

### GSI (Global Secondary Index)

Um GSI é uma "visão reordenada" da **mesma** tabela, com outra PK e outra SK. O item é gravado uma vez, e o
DynamoDB mantém o índice sozinho. Ele existe para responder a um **segundo padrão de acesso** que a chave
principal não atende, e custa capacidade de escrita extra a cada gravação.

### Single-Table Design

Várias entidades na **mesma tabela**, diferenciadas por prefixos nas chaves:

| Entidade | PK | SK | GSI1PK | GSI1SK |
|---|---|---|---|---|
| User | `USER#u1` | `PROFILE` | — | — |
| Project | `USER#u1` | `PROJECT#p1` | — | — |
| Task | `PROJECT#p1` | `TASK#2026-10-01T10:00:00Z#t1` | `USER#<assignee>` | `TASK#2026-10-01T10:00:00Z#t1` |

O `#` é só convenção de leitura, sem significado especial para o DynamoDB.

---

## 🏗️ O modelo: `TaskFlowTable`

### Padrões de acesso

| # | Pergunta | Operação |
|---|---|---|
| AP1 | Tarefas de um projeto, mais recentes primeiro | `Query` · `PK = PROJECT#<id>` · `begins_with(SK, 'TASK#')` · `ScanIndexForward: false` |
| AP2 | Projetos de um usuário | `Query` · `PK = USER#<id>` · `begins_with(SK, 'PROJECT#')` |
| AP3 | Uma tarefa específica | `GetItem` · `PK` + `SK` exatos |
| AP4 | Tarefas atribuídas a um usuário | `Query` no **GSI1** · `GSI1PK = USER#<id>` |

O AP4 é o motivo do GSI existir: a chave principal das tarefas é `PROJECT#…`, e a pergunta é por `USER#…`.

---

## 📋 Como reproduzir

### 1. Infraestrutura

```bash
docker compose up -d localstack        # emula DynamoDB, S3, SQS, SNS e IAM em http://localhost:4566
```

### 2. Clientes do SDK

| Pacote | Uso |
|---|---|
| `@aws-sdk/client-dynamodb` | Cliente de baixo nível: exige o formato tipado `{ S: 'valor' }` |
| `@aws-sdk/lib-dynamodb` | `DynamoDBDocumentClient`: aceita objetos JavaScript comuns (é o que as queries usam) |

```ts
// src/dynamo/client.ts
const baseClient = new DynamoDBClient({
  region: 'us-east-1',
  endpoint: 'http://localhost:4566',                      // LocalStack (na AWS real, omite-se o endpoint)
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
export const dynamo = DynamoDBDocumentClient.from(baseClient);
export const TABLE_NAME = 'TaskFlowTable';
```

### 3. Chaves centralizadas ([`model.ts`](../../src/dynamo/model.ts))

```ts
export const keys = {
  user:    (userId: string) => ({ PK: `USER#${userId}`, SK: 'PROFILE' }),
  project: (userId: string, projectId: string) => ({ PK: `USER#${userId}`, SK: `PROJECT#${projectId}` }),
  task:    (projectId: string, createdAt: string, taskId: string) => ({
    PK: `PROJECT#${projectId}`,
    SK: `TASK#${createdAt}#${taskId}`, // createdAt PRIMEIRO → ordenação cronológica
  }),
};

export const gsiKeys = {
  taskByAssignee: (assigneeId: string, createdAt: string, taskId: string) => ({
    GSI1PK: `USER#${assigneeId}`,
    GSI1SK: `TASK#${createdAt}#${taskId}`,
  }),
};
```

Gerar as chaves sempre pela mesma função evita o bug clássico de um script gravar `USER#u1` e outro buscar `USER-u1`.

### 4. Tabela com GSI ([`createTable.ts`](../../src/dynamo/createTable.ts))

```ts
new CreateTableCommand({
  TableName: TABLE_NAME,
  BillingMode: 'PAY_PER_REQUEST',           // on-demand: sem planejar capacidade
  AttributeDefinitions: [                   // SÓ os atributos usados em chaves
    { AttributeName: 'PK', AttributeType: 'S' },
    { AttributeName: 'SK', AttributeType: 'S' },
    { AttributeName: 'GSI1PK', AttributeType: 'S' },
    { AttributeName: 'GSI1SK', AttributeType: 'S' },
  ],
  KeySchema: [
    { AttributeName: 'PK', KeyType: 'HASH' },   // Partition Key
    { AttributeName: 'SK', KeyType: 'RANGE' },  // Sort Key
  ],
  GlobalSecondaryIndexes: [{
    IndexName: 'GSI1',
    KeySchema: [
      { AttributeName: 'GSI1PK', KeyType: 'HASH' },
      { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  }],
});
```

**`Projection`:** `KEYS_ONLY` (mais barato, mas exige um segundo `GetItem` para ler os dados), `INCLUDE`
(atributos escolhidos) ou `ALL` (índice maior e mais caro, mas a query já devolve tudo). Para estudo, `ALL`.

O script trata **só** o `ResourceNotFoundException` ao verificar se a tabela existe. Qualquer outro erro (rede,
credencial) sobe, em vez de ser engolido por um `catch {}` genérico.

### 5. Dados e consultas

```bash
npm run dynamo:create      # cria a tabela (idempotente)
npm run dynamo:seed        # 2 usuários, 3 projetos, 6 tarefas (com GSI1PK/GSI1SK)
npm run dynamo:queries     # AP1, AP2, AP3
npm run dynamo:query-gsi   # AP4
npm run dynamo:list        # lista tabelas
npm run dynamo:delete      # remove a tabela
```

```ts
// AP1 — tarefas do projeto, mais recentes primeiro
new QueryCommand({
  TableName: TABLE_NAME,
  KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
  ExpressionAttributeValues: { ':pk': `PROJECT#${projectId}`, ':sk': 'TASK#' },
  ScanIndexForward: false,
});

// AP4 — tarefas de um assignee, pelo GSI
new QueryCommand({
  TableName: TABLE_NAME,
  IndexName: 'GSI1',
  KeyConditionExpression: 'GSI1PK = :pk AND begins_with(GSI1SK, :sk)',
  ExpressionAttributeValues: { ':pk': `USER#${assigneeId}`, ':sk': 'TASK#' },
  ScanIndexForward: false,
});
```

No AP2, o `begins_with(SK, 'PROJECT#')` é o que separa os projetos do item `PROFILE`, que mora **na mesma
partição** `USER#u1`.

| Operação | Como encontra os itens | Custo |
|---|---|---|
| `GetItem` | Chave completa (PK + SK) | O mais barato: vai direto ao item |
| `Query` | Uma partição, filtrada pela SK | Proporcional ao que é lido |
| `Scan` | **A tabela inteira** | ❌ Anti-pattern em produção: lento e caro |

---

## 🔗 Conexão com a arquitetura do TaskFlow

Os conceitos deste módulo reaparecem, com outro nome, no código da API em PostgreSQL:

| No TaskFlow (PostgreSQL) | Equivalente no DynamoDB |
|---|---|
| **Read Model** `tasks_read`, projeção otimizada para leitura (CQRS) | Uma tabela DynamoDB é um Read Model clássico: com CQRS, o lado de **leitura** pode usar outro banco, alimentado pelas mesmas projeções |
| **Paginação por cursor** (`?cursor=<id>`, [`pagination.dto.ts`](../../src/common/dto/pagination.dto.ts)) | `LastEvaluatedKey` → `ExclusiveStartKey`: no DynamoDB, **só existe** paginação por cursor |
| **Concorrência otimista** no Event Store (`UNIQUE (aggregate_id, version)`) | `ConditionExpression: 'version = :esperada'` no `UpdateItem` |
| **Projeção idempotente** (`INSERT … ON CONFLICT DO NOTHING`) | `PutItem` com `ConditionExpression: 'attribute_not_exists(PK)'` |

---

## 💡 Perguntas respondidas

### 1. O DynamoDB é usado sozinho ou junto com um banco relacional?

**As duas coisas.** Como banco único, ele sustenta sistemas de altíssimo volume com padrões de acesso fixos: o
carrinho da Amazon, metadados da Netflix, o progresso de usuários do Duolingo. Mas exige que as perguntas sejam
conhecidas desde o início, sem relatórios *ad hoc* nem `JOIN`s.

O cenário mais comum em empresas é **combinar** os dois:

| Função | Banco |
|---|---|
| Fonte da verdade, transações, relatórios e BI | PostgreSQL |
| Leitura de altíssimo volume e baixa latência | DynamoDB |
| Sessões com expiração automática | DynamoDB (TTL) |
| Contadores e rankings | DynamoDB (contadores atômicos) |

```text
App → API → PostgreSQL (fonte da verdade)
              ↓ projeção / evento
            DynamoDB (leitura rápida)
```

**Exemplo:** num sistema financeiro, o PostgreSQL guarda os lançamentos normalizados e auditáveis, e uma projeção
mantém no DynamoDB o **saldo consolidado** por cliente, lido pelo app em milissegundos. É exatamente o padrão
CQRS deste projeto, com bancos diferentes em cada lado.

### 2. Onde o DynamoDB fica hospedado? Dá para consultar visualmente?

É um serviço **totalmente gerenciado** da AWS (servidores, replicação em 3 zonas de disponibilidade, backup e
escala ficam com a AWS). Aqui ele roda **localmente** no LocalStack. O código é o mesmo; só muda o `endpoint`.

| Ambiente | Como explorar os dados |
|---|---|
| AWS real | Console → DynamoDB → *Explore table items* |
| LocalStack | `npx dynamodb-admin --dynamo-endpoint=http://localhost:4566` (UI em `localhost:8001`) |
| Qualquer um | AWS CLI: `aws --endpoint-url=http://localhost:4566 dynamodb scan --table-name TaskFlowTable` |
| Modelagem | NoSQL Workbench (app desktop da AWS) |

### 3. O que cada arquivo faz?

| Arquivo | Responsabilidade |
|---|---|
| `client.ts` | Cliente (DocumentClient) e nome da tabela |
| `model.ts` | Geração centralizada das chaves (PK, SK, GSI1PK, GSI1SK) |
| `createTable.ts` · `deleteTable.ts` · `listTables.ts` | Ciclo de vida da tabela |
| `seed.ts` | Dados de exemplo |
| `queries.ts` · `queryGsi.ts` | AP1–AP3 e AP4 |

---

## ⚠️ Problemas encontrados e soluções

| # | Problema | Causa | Solução |
|---:|---|---|---|
| 1 | `Not Found` em `/_localstack/dynamodb/tables` | Esse endpoint HTTP não existe no LocalStack | Usar `ListTablesCommand` pelo SDK |
| 2 | `catch {}` vazio escondia qualquer erro | Tratamento genérico demais | Capturar **só** `ResourceNotFoundException` |
| 3 | Não foi possível criar o GSI na tabela existente | A abordagem do script (`CreateTable`) define índices só na criação | Apagar e recriar a tabela (na AWS, um GSI novo pode ser adicionado com `UpdateTable`, sem recriar) |
| 4 | AP4 impossível com a chave principal | A PK das tarefas é `PROJECT#`, e a pergunta é por `USER#` | Criar o GSI1 com `GSI1PK = USER#<assignee>` |

---

## 📊 Resultados

**AP1, tarefas do projeto `p1`**, em ordem cronológica decrescente, sem `ORDER BY`:

```text
[2026-10-08T09:15:00Z] Documentar API (PENDING)
[2026-10-05T14:30:00Z] Adicionar testes (IN_PROGRESS)
[2026-10-01T10:00:00Z] Criar endpoint de listagem (DONE)
```

**AP2, projetos do usuário `u1`:** `Refatorar API (p1)` · `Estudar DynamoDB (p2)`. O `PROFILE` ficou de fora graças ao `begins_with`.

**AP3, tarefa específica:** `Adicionar testes · IN_PROGRESS · 2026-10-05T14:30:00Z`, via `GetItem`, sem varrer nada.

**AP4, tarefas por responsável**, via GSI1:

```text
=== u1 ===
[2026-10-05T14:30:00Z] Adicionar testes (IN_PROGRESS) — projeto p1
[2026-10-03T08:00:00Z] Ler documentação oficial (DONE) — projeto p2
[2026-10-01T10:00:00Z] Criar endpoint de listagem (DONE) — projeto p1
=== u2 ===
[2026-10-08T09:15:00Z] Documentar API (PENDING) — projeto p1
[2026-10-07T16:45:00Z] Modelar tabela (IN_PROGRESS) — projeto p2
[2026-10-06T11:20:00Z] Planejar migração (PENDING) — projeto p3
```

Mesma tabela, mesmos itens, mas agrupados e ordenados por outra chave.

---

## 🚧 Limitações e próximos passos

- **Configuração repetida:** endpoint, região e credenciais do LocalStack estão fixos e **repetidos em 4 arquivos** (`client.ts`, `createTable.ts`, `deleteTable.ts`, `listTables.ts`). O certo seria um único cliente configurado por variável de ambiente, o mesmo princípio aplicado à API no [`env.schema.ts`](../../src/config/env.schema.ts).
- **Scripts dentro de `src/`:** são laboratório, não código de produção. O lugar natural seria `scripts/` ou `labs/`.
- **Sem paginação nas queries:** os scripts leem uma página só. Com dados reais, seria preciso iterar pelo `LastEvaluatedKey`.
- **Próximo experimento natural:** alimentar a tabela DynamoDB a partir das **projeções** do TaskFlow (o `tasks_read` em DynamoDB), demonstrando CQRS com bancos diferentes em cada lado.

---

## ✅ Checklist

- [x] LocalStack com DynamoDB
- [x] 4 padrões de acesso definidos **antes** das chaves (query-first)
- [x] Single-Table Design com prefixos (`USER#`, `PROJECT#`, `TASK#`)
- [x] GSI1 para o padrão de acesso secundário (AP4)
- [x] Scripts separados por responsabilidade, com tratamento de erro específico
- [x] Comparação PostgreSQL × DynamoDB e conexão com o CQRS da API
- [ ] Cliente único configurado por ambiente
- [ ] Read Model do TaskFlow projetado em DynamoDB

---

**Anterior:** [Módulo 03 — CI/CD com GitHub Actions](03-ci-cd-github-actions.md) ·
**Próximo:** [Módulo 05 — Event Sourcing e CQRS](05-event-sourcing-cqrs.md)
