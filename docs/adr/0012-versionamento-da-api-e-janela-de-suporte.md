# ADR-0012: Versionamento da API e janela de suporte

- **Status:** Aceito
- **Decisão:** 24/11/2026 (Módulo 14.8) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0008](0008-depreciacao-e-remocao-de-campos-da-api.md) (depreciação e remoção) ·
  [ADR-0009](0009-idempotencia-de-requisicoes-na-transacao-do-efeito.md) · [ADR-0010](0010-feature-flags-proprias.md) ·
  [ADR-0011](0011-criterio-de-avanco-do-rollout.md) · [Módulo 14](../modules/14-api-para-web-e-apps.md)

## Contexto

O Módulo 14 construiu as peças da compatibilidade com apps instalados: identificação do cliente (14.1), versão mínima
(14.2), contrato no CI (14.3), expand/contract com depreciação (14.4), `Idempotency-Key` (14.5) e feature flags (14.6,
14.7). Falta a política que diz **quando usar cada uma**, com números, para que "como vocês versionam a API?" tenha uma
resposta, e não uma lista de ferramentas.

As forças: o web atualiza a cada deploy; uma versão de app vive meses; publicar no app leva dias (a revisão da loja);
e a API precisa evoluir sem carregar cada formato antigo para sempre.

## Decisão

**1. Sem versão na URL por padrão.** A API evolui por mudanças **compatíveis**: campo ou rota novos e opcionais. Uma
mudança **incompatível** passa pelo ciclo do [ADR-0008](0008-depreciacao-e-remocao-de-campos-da-api.md): expand →
`Sunset` → versão mínima → contract. O oasdiff no CI (14.3) bloqueia a incompatível não anunciada.

**2. O cliente é um leitor tolerante.** A API acrescenta campos sem avisar (é compatível), então o app ignora o que
não conhece, inclusive valores novos onde o contrato permitir. Está escrito na descrição do Swagger.

**3. `/v2` só para redesenho**: quando o modelo de um recurso muda de natureza, e o expand/contract viraria duas APIs
dentro de uma. Aí `/v1` e `/v2` convivem durante a janela de suporte, e o `/v1` segue o mesmo ciclo de depreciação.

**4. A janela de suporte:**

| Regra | Valor | Por quê |
|---|---|---|
| Versões do app suportadas | Toda versão lançada nos **últimos 6 meses** | Cobre quem atualiza devagar, sem segurar a API para sempre |
| Subir a versão mínima | Só até uma versão lançada **há 6 meses ou mais** | É a janela vista do outro lado |
| Exceção | Bug grave ou de segurança: 426 **na hora**, para a versão afetada | Proteger o usuário vence a janela (o caso que motivou a 14.2) |
| Aviso de depreciação | `Sunset` pelo menos **90 dias** depois do `Deprecation` (verificado no CI) | O tempo de o app publicar uma versão e os usuários atualizarem |
| Web | Sem janela; abas abertas recebem a versão mínima do web | Um SPA aberto há dias é o "app antigo" da web |

**5. O mapa de decisão:**

| Mudança | Ferramenta |
|---|---|
| Campo ou rota novo, opcional | Só fazer (o oasdiff confirma que é compatível) |
| Renomear ou mudar o formato de um campo | Expand/contract + `Sunset` ([ADR-0008](0008-depreciacao-e-remocao-de-campos-da-api.md)) |
| Funcionalidade nova arriscada | Feature flag + critério de avanço ([ADR-0010](0010-feature-flags-proprias.md), [ADR-0011](0011-criterio-de-avanco-do-rollout.md)) |
| Versão do app quebrada | Versão mínima → 426 (14.2) |
| Operação que não pode duplicar | `Idempotency-Key` ([ADR-0009](0009-idempotencia-de-requisicoes-na-transacao-do-efeito.md)) |
| Redesenho de um recurso | `/v2` em paralelo, na janela de suporte |

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Versão na URL desde já** (`/v1/...` e um `/v2` a cada quebra) | Cada versão duplica rotas, testes e documentação; com apps, a versão velha vive o mesmo tempo que um campo depreciado viveria. Bom para redesenho, caro para trocar um campo |
| **Versão por header** (`Accept: application/vnd.taskflow.v2+json`) | Mesmo custo da URL, menos visível (cache, logs, curl) e com suporte irregular em ferramentas |
| **Versionamento por data** (o modelo do Stripe: cada conta fixada na versão do dia da integração) | Excelente para uma API pública com milhares de integradores, que não podem ser forçados a atualizar. Aqui o cliente é o nosso app, e a versão mínima força a atualização: a complexidade não se paga |
| **Suportar todas as versões para sempre** | O código acumula formatos e o banco, colunas; a segurança fica refém do app mais antigo |
| **Janela por quantidade** ("as 3 últimas versões") | Depende da cadência de lançamento: com uma versão por semana, 3 versões são 3 semanas. O tempo é o que o usuário sente |

## Consequências

**Positivas**
- Uma resposta única para "posso mudar isso?": o mapa de decisão e a janela, com números.
- A parte verificável da política está no CI: compatibilidade (oasdiff) e aviso mínimo (o teste da lista de campos
  depreciados).
- Sem versões paralelas da API no caso comum.

**Negativas**
- **A janela de 6 meses não é imposta pelo código:** o comando `app-version` não sabe a data de lançamento de cada
  versão (é um dado da loja, não da API). Depende de quem sobe a versão mínima consultar o painel "Clientes" e a data.
- **Leitor tolerante é uma exigência ao cliente:** um app que quebra com um campo novo quebra mesmo com a API correta.
- **6 meses e 90 dias são escolhas**, razoáveis para um app de produtividade; num app bancário regulado, os prazos
  podem vir de norma.

## Revisitar quando

- **A API ganhar integradores externos** (parceiros, API pública): aí versionamento explícito (URL ou por data) passa
  a compensar, porque não há versão mínima para forçar em quem não é nosso.
- **A cadência de lançamento do app mudar muito**, ou a adoção de versões (o painel "Clientes") mostrar que 6 meses
  deixam muita gente para trás.

## Evidência

- Compatibilidade no CI: oasdiff no workflow "Contrato da API"; o ciclo completo exercido no `dueDate` (14.4a a 14.4c).
- Aviso mínimo no CI: [`deprecation-policy.spec.ts`](../../test/unit/deprecation-policy.spec.ts) (89 dias falha, 90 e o
  `dueDate` com 97 passam).
- A política para quem desenvolve o app: a descrição do Swagger (`docs/api/openapi.json`, `info.description`).
