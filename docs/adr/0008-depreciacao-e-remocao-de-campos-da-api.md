# ADR-0008: Depreciação e remoção de campos da API

- **Status:** Aceito
- **Decisão:** 24/11/2026 (Módulo 14.4) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0004](0004-evento-de-integracao-separado-do-dominio.md) (o mesmo princípio para o contrato do
  tópico) · [Módulo 14](../modules/14-api-para-web-e-apps.md) (versão mínima, contrato no CI, expand/contract)

## Contexto

A API atende o front web, que atualiza a cada deploy, e apps instalados, que não. Uma versão do app vive meses; toda
mudança de contrato tem de considerar todas as versões ainda em uso. O primeiro caso real foi trocar o prazo
`dueDate` (só o instante) por `due { at, timezone }` (o instante e o fuso, para lembretes no dia certo).

As forças:
- remover um campo que um app instalado usa quebra esse app até o usuário atualizar;
- manter os dois formatos para sempre acumula código, colunas e ambiguidade;
- a API tem como medir quem **envia** um campo, mas não quem o **lê**;
- um deploy não é atômico: por alguns minutos, a versão anterior e a nova estão no ar juntas.

## Decisão

Todo campo da API (e coluna do read model) que muda de forma passa por **expand → transição → contract**:

**1. Expand (compatível).** O formato novo entra ao lado do antigo, nos dois sentidos. O antigo é marcado como
depreciado em três lugares:
- no OpenAPI (`deprecated: true`), que o oasdiff e os geradores de cliente leem;
- nas respostas de quem o usa: `Deprecation` (RFC 9745), `Sunset` (RFC 8594) e `Link` com `rel="deprecation"`, pelo
  `DeprecationNotifier`;
- numa métrica por versão do app: `taskflow_deprecated_field_usage_total{field, platform, app_version}`.

**2. Contract, só quando os TRÊS critérios valem:**
1. a data do `Sunset` publicada passou;
2. a versão mínima do app (14.2) está acima de toda versão que usa o campo antigo: essas recebem 426 antes de chegar à
   validação, e o usuário vê "atualize", não um erro;
3. a métrica de uso está zerada para as versões acima da mínima.

**3. O contract tem dois deploys.** Primeiro o código para de gravar e de ler o antigo (e um backfill final roda); só
num deploy seguinte a coluna sai do banco. Juntos, a versão anterior, ainda no ar durante o deploy, quebraria ao
gravar numa coluna que já não existe.

**4. Eventos gravados nunca mudam.** Formato novo de um evento de domínio = versão nova + *upcaster* na leitura, que
fica para sempre (os eventos antigos continuam lá). O contrato público do tópico tem o próprio ciclo
([ADR-0004](0004-evento-de-integracao-separado-do-dominio.md)).

**5. O que o CI garante, e o que não.** O oasdiff (14.3) bloqueia mudança incompatível **não anunciada**. Ele aceita, por
desenho, a remoção de um campo que foi depreciado antes, e a remoção de um campo de resposta documentado como
opcional (o cliente deveria tolerar a ausência). Ou seja: **o CI pega a quebra acidental; a quebra planejada é
decidida por estes critérios**, e a label `breaking-change` aprova o que o oasdiff ainda classificar como erro.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Versionar a API pela URL** (`/v2/tasks`) | Duplica rotas, testes e documentação para cada mudança; com apps, a v1 vive o mesmo tempo que um campo depreciado viveria. Faz sentido para uma reescrita, não para trocar um campo |
| **Nunca remover** (só acrescentar) | O contrato acumula formatos e ambiguidade; e o banco, colunas mortas |
| **Remover na data do `Sunset`, automaticamente** | A data é uma intenção; o que decide é quem ainda usa (versão mínima e métrica). Uma remoção automática quebraria quem ficou para trás |
| **Contract num deploy só** (código e coluna juntos) | A versão anterior, no ar durante o deploy, quebraria ao gravar na coluna removida |
| **Confiar só no oasdiff** | Ele aceita, por desenho, remover o que foi depreciado ou documentado como opcional (ver "O que o CI garante") |

## Consequências

**Positivas**
- Nenhuma versão de app quebra por surpresa: o campo antigo some só depois de esses apps serem levados a atualizar.
- A decisão de remover é baseada em dado (a métrica) e em política (a versão mínima), não em memória.
- O mesmo caminho vale para a API, o banco e os eventos, cada um com a sua forma de compatibilidade.

**Negativas**
- **Mais lento:** uma troca de campo leva três a quatro PRs e semanas de transição.
- **Dá para medir quem envia, não quem lê:** um app que só LÊ o campo antigo não aparece na métrica. Por isso o
  critério 2 (versão mínima) é o que de fato protege.
- **O contrato precisa ser preciso:** um campo de resposta que vem sempre, mas está documentado como opcional, sai sem
  o CI perceber (foi o caso do `dueDate`, achado no 14.4b). Campos sempre presentes devem ser `required` (podem ser
  `nullable`).
- **Cliente sem versão** (curl, integração, front antigo sem o header) não é barrado pelo 426: depois do contract, ele
  recebe 400.

## Revisitar quando

- **A API ganhar clientes de terceiros** (parceiros, integrações públicas): aí uma versão na URL ou por header pode
  compensar, porque não há "versão mínima" para forçar em quem não é nosso.
- **As mudanças ficarem frequentes:** schema registry e geração de cliente a partir do OpenAPI tornariam o ciclo mais
  barato.

## Evidência

- Expand: oasdiff com 0 incompatíveis e o `changelog` marcando o `dueDate` como depreciado em 3 lugares; app antigo e
  app novo lado a lado no E2E (14.4a).
- Contract: com a mínima em 2.14.0, o app 2.13 recebe 426; cliente sem versão com `dueDate`, 400; listagem e histórico
  sem `dueDate`: [`due.e2e-spec.ts`](../../test/e2e/due.e2e-spec.ts).
- Upcaster lendo um evento v1 gravado, com o banco intacto: [`due-expand.spec.ts`](../../test/integration/due-expand.spec.ts).
- O oasdiff no contract: `request-property-removed-with-deprecation` e `response-optional-property-removed`, ambos
  informativos (Módulo 14, problema 11).
