# Módulo 08 — IA no Desenvolvimento (AI-Assisted Engineering)

> **Projeto:** TaskFlow · **Trilha:** Do Pleno ao Excelente · **Última revisão:** 18/10/2026
>
> **Onde vive no código:** [`AGENTS.md`](../../AGENTS.md) (contexto para agentes de IA) ·
> [`CLAUDE.md`](../../CLAUDE.md) (aponta para o `AGENTS.md`)

---

## 🎯 Objetivo

Usar IA generativa como **multiplicador** no ciclo de desenvolvimento (arquitetura, código, testes, revisão,
documentação) **sem terceirizar o julgamento**: saber quando confiar, quando verificar e como dar contexto para que
a IA acerte.

**Por que importa:** IA já faz parte do fluxo de trabalho da maioria dos times. O diferencial não é usar, e sim
usar com **método**: contexto bem escrito, passos pequenos e verificação sistemática.

---

## 🧠 Parte 1 — O panorama das ferramentas

| Categoria | Exemplos | Uso típico |
|---|---|---|
| Assistentes de chat | Claude, ChatGPT, Gemini, DeepSeek | Explicar código, brainstorm de arquitetura, revisar |
| Autocomplete no editor | GitHub Copilot | Completar linhas e funções enquanto se digita |
| IDE com IA nativa | Cursor | Editar vários arquivos com contexto do projeto |
| **Agentes de código** | Claude Code, Codex | Ler o repositório, rodar comandos, editar e testar em ciclos |

| Na AWS | Papel |
|---|---|
| **Amazon Q Developer** | Assistente no console e no editor |
| **Amazon Bedrock** | Plataforma para consumir vários modelos (Claude, Llama, Mistral…) pagando por token |
| **Bedrock Agents** | Agentes que executam tarefas com ferramentas |

---

## 🧠 Parte 2 — Quando usar (e quando redobrar o cuidado)

> **Regra de ouro:** a IA é apoio, não substituto. **Quem faz o merge é o responsável pelo código.**

| ✅ Bom uso | ⚠️ Cuidado redobrado |
|---|---|
| Entender código desconhecido | Código que mexe com **dinheiro** |
| Boilerplate e CRUD | **Autenticação, criptografia, autorização** |
| Casos de teste e casos de borda | **Migrações de banco** (SQL destrutivo é fácil de gerar e difícil de desfazer) |
| Revisar código e documentação | Configuração de produção |
| Refatorar com testes cobrindo | Decisões arquiteturais finais (o contexto do negócio importa) |
| Levantar hipóteses de bug | **Dados sensíveis**: nunca colar senha, token ou dado pessoal (LGPD) no prompt |

"Cuidado redobrado" não significa "não usar": significa **verificar mais**. Neste projeto, a autorização e as
migrações foram escritas com IA, e foram justamente as áreas com mais verificação (testes E2E de intruso, revisão
manual do SQL gerado, `count(*)` antes de migrar).

---

## 🧠 Parte 3 — Arquivos de contexto

Agentes de IA leem arquivos Markdown do repositório para entender o projeto antes de sugerir código.

| Arquivo | Lido por |
|---|---|
| **`AGENTS.md`** | Padrão neutro, lido por vários agentes (Claude Code, Codex, Cursor…) |
| `CLAUDE.md` | Claude Code |
| `.cursorrules` | Cursor |
| `.github/copilot-instructions.md` | GitHub Copilot |

No TaskFlow, o **[`AGENTS.md`](../../AGENTS.md) é a fonte única**, e o `CLAUDE.md` só aponta para ele: um
conteúdo, um lugar para manter.

### O que um bom arquivo de contexto tem

| Seção | Por quê |
|---|---|
| Comandos (dev, testes, banco) | A IA roda o comando certo, com as flags certas |
| **Onde fica cada coisa**, com a regra de cada pasta | Ex.: "`domain/` não importa infraestrutura" |
| **Receitas** ("adicionar um evento novo: 5 lugares") | Conhecimento que não dá para deduzir lendo um arquivo só |
| **NÃO FAÇA**, específico do projeto | Ex.: "`userId` só do JWT, nunca do body" |
| **O que AINDA NÃO existe** | Sem isso, a IA assume que existe e gera código que referencia algo inexistente |
| Checklist antes de propor código | Autorização, testes, migração revisada |

### ⚠️ Um arquivo de contexto errado é pior do que nenhum

O `AGENTS.md` deste projeto chegou a descrever uma `BankClientFactory`, camadas
`domain/application/infrastructure` genéricas e logs com `correlationId`, **nada disso existia**. Um agente lendo
aquilo geraria código importando classes inexistentes, ou "corrigiria" o projeto para caber na descrição. Por isso:

- o arquivo é **versionado e revisado no mesmo PR** que muda o comportamento;
- cada caminho e símbolo citado foi **verificado** contra o código na última revisão;
- há uma seção explícita **"Ainda NÃO implementado (não assuma que existe)"**.

---

## 🧠 Parte 4 — Prompt engineering

### Estrutura

```text
[PAPEL]      Você é um engenheiro sênior especializado em X.
[CONTEXTO]   O projeto faz Y, usa Z. (ou: "leia o AGENTS.md")
[TAREFA]     Preciso de W.
[RESTRIÇÕES] Siga A, B, C. Não altere D.
[FORMATO]    Responda como E.
[EXEMPLO]    Algo no formato que espero: …
```

| ❌ Vago | ✅ Específico |
|---|---|
| "Me ajuda com código" | "Preciso de um handler CQRS em NestJS que persista `TaskCreated` seguindo o padrão do arquivo X" |
| "Faça testes" | "Gere testes do `AuthService` cobrindo: sucesso, senha errada, e-mail inexistente e a **mesma mensagem** nos dois erros" |
| "Corrige isso" | "Este código lança X quando executo Y. Liste 2 hipóteses e como testar cada uma **antes** de corrigir" |
| "Otimize" | "Esta query leva 4 s no p95. Sugira índices e reescreva com paginação por cursor" |

**Técnicas úteis:** pedir hipóteses ordenadas por probabilidade antes da solução; dar exemplos do formato esperado
(*few-shot*); pedir que a IA **aponte o que não sabe** em vez de preencher com suposição.

---

## 🧪 Parte 5 — Estudo de caso: as correções do TaskFlow com um agente de IA

As correções descritas nos módulos 01 a 07 (autorização, concorrência, Event Sourcing completo, testes,
documentação) foram feitas em **pair programming com um agente de IA** (Claude Code). O processo e os erros são
mais instrutivos do que o resultado.

### O processo

1. **Análise antes de código:** o agente percorreu o repositório e produziu um relatório com problemas
   priorizados (🔴/🟡/🟢), cada um citando o arquivo.
2. **Plano em blocos**, ordenados por risco: limpeza do Git → configuração → autorização → Event Store →
   domínio → testes → documentação.
3. **Regras de interação**, definidas por quem estava aprendendo:
   - no máximo ~3 arquivos por passo;
   - cada passo explica **o que**, **por quê** e **como**;
   - `tsc`, testes e lint ao fim de **todo** passo, e o próximo só começa com tudo verde;
   - confirmação explícita antes de ações irreversíveis (o `push --force` da reescrita de histórico).
4. **Uma branch e um PR por bloco**, com o CI como juiz.

### O que a verificação pegou

A parte mais valiosa: **erros da própria IA**, todos capturados pelas verificações do processo, antes do merge.

| Erro | Quem pegou |
|---|---|
| `import()` dinâmico testado no Jest (passou), mas inválido para o TypeScript com `module: nodenext` | `tsc --noEmit` no fim do passo |
| Cast `JsonValue → TaskDomainEvent` inválido, com os testes passando | `tsc` (o `ts-jest` só transpila) |
| Dois *warnings* de lint (`no-misused-spread`) introduzidos e não notados | Rodar o lint em todo passo, e não só o `tsc` e os testes |
| Edição aplicada num caminho de arquivo duplicado (`taskflow\taskflow\…`) | A ferramenta recusou; corrigido antes de seguir |
| Estimativa de tempo da suíte de testes em fila (~1 min) muito otimista (foram ~3 min) | Medição real |
| Uma migração gerada pelo ORM que **apagaria dados** (`DROP COLUMN` numa troca de tipo) | Revisão do SQL com `--create-only`, antes de aplicar |
| Afirmações erradas em documentos antigos (*"DynamoDB não permite adicionar GSI"*, *"optimistic locking"* que ainda não existia) | Revisão dos módulos **contra o código** e a documentação oficial |

### Técnicas de verificação que funcionaram

| Técnica | Exemplo |
|---|---|
| **Experimento em vez de suposição** | Um teste temporário de 5,5 s provou que o `testTimeout` dentro de `projects` era ignorado pelo Jest |
| **Conferir dados antes de migrar** | `count(*)` antes de criar uma coluna `NOT NULL` ou um `UNIQUE` |
| **Smoke test do boot** | Erros de injeção de dependência não aparecem em testes unitários, só ao subir a aplicação |
| **Validação automática de links** | Script que confere se todo link relativo de um documento aponta para um arquivo existente |
| **Rodar 3 vezes** | Testes com consistência eventual só são confiáveis se forem estáveis |
| **Fatos verificados antes de documentar** | Senha do Grafana, porta das métricas e versão do Dockerfile conferidas no código antes de entrar no README |

### Lições

1. **Passos pequenos tornam o erro barato.** Um erro em 3 arquivos se acha em minutos; em 30, numa tarde.
2. **A IA erra com confiança.** O `import()` "funcionou" (no Jest), e só o `tsc` disse o contrário. Verificação automática vale mais que revisão por leitura.
3. **Peça evidência, não afirmação.** "Funciona?" é uma pergunta fraca; "rode o teste e mostre a saída" é forte.
4. **Documentação gerada por IA precisa ser checada contra o código**, com o mesmo rigor de código gerado.
5. **Quem aprende precisa entender cada mudança.** O formato "o quê, por quê, como" foi o que transformou as correções em estudo.

---

## ⚠️ Problemas comuns (e como evitar)

| Problema | Como evitar |
|---|---|
| Código plausível, mas errado | Testes + `tsc` + lint a cada mudança; revisão linha a linha em código crítico |
| API "alucinada" (função ou opção que não existe) | Conferir na documentação oficial; compilar e rodar |
| Dados sensíveis no prompt | Nunca colar senha, token, dado pessoal ou de cliente |
| Aprovar o que não entendeu | Se não consegue explicar a mudança, não faça o merge |
| Contexto perdido em conversas longas | Arquivos de contexto no repositório; resumos; sessões focadas |
| Arquivo de contexto desatualizado | Tratar como código: atualizar no mesmo PR, revisar |
| Resíduos de conversa colados no repositório | Arquivo de contexto só com o que é verdade sobre o projeto |

### Achados do primeiro `CLAUDE.md`

Ao pedir à IA que lesse e explicasse o primeiro arquivo de contexto do projeto, ela encontrou 9 problemas **no
próprio documento**:

| # | Problema | Categoria |
|---|---|---|
| 1 | Trechos de conversa colados ("Lição de ouro…") | Estrutura |
| 2 | Conteúdo de **outro projeto** (fila, ACK, `Retry-After`) | Contexto errado |
| 3 | Nomes de domínio errados (`Launch`, `SyncMessage`) | Domínio |
| 4 | Credenciais em texto claro | Segurança |
| 5 | Blocos de código sem marcação | Formatação |
| 6 | Campo de log inconsistente | Padronização |
| 7 | `correlationId` gerado **dentro** de cada log (cada linha teria um ID diferente, quebrando o rastreio) | Bug técnico |
| 8 | Métricas citadas sem existir no código | Precisão |
| 9 | CORS apontando para `localhost:3001`, a porta do Grafana | Configuração |

---

## ✅ Checklist

- [x] Panorama das ferramentas e equivalentes na AWS
- [x] Critérios de quando usar e quando redobrar o cuidado
- [x] `AGENTS.md` como fonte única de contexto, verificado contra o código
- [x] Seção "o que ainda não existe" para evitar alucinação
- [x] Correções do projeto feitas com IA, em passos pequenos e com verificação a cada passo
- [x] Erros da IA capturados pelo processo, antes do merge
- [ ] `.github/copilot-instructions.md` e template de PR (`.github/PULL_REQUEST_TEMPLATE.md`)

---

**Anterior:** [Módulo 07 — Testes](07-testes.md) ·
**Próximo:** [Módulo 09 — Infraestrutura como Código](09-infraestrutura-como-codigo.md)
