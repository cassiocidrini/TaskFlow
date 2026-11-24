# ADR-0010: Feature flags em módulo próprio (porta + Postgres), e não um serviço gerenciado

- **Status:** Aceito
- **Decisão:** outubro de 2026 (no plano dos Módulos 13 e 14) · **Registro:** 24/11/2026 (Módulo 14.6)
- **Relacionados:** [ADR-0008](0008-depreciacao-e-remocao-de-campos-da-api.md) (versão mínima e compatibilidade) ·
  [Módulo 14](../modules/14-api-para-web-e-apps.md)

## Contexto

Funcionalidades novas precisam ser liberadas aos poucos (time interno → 10% → 50% → todos) e **desligadas em segundos**
se algo der errado. Com apps, o "em segundos" é decisivo: corrigir uma tela nova exige publicar uma versão na loja, o
que leva horas ou dias. As regras precisam considerar o usuário (lista de testadores, porcentagem) e o app (plataforma
e versão mínima, porque a tela nova só existe a partir de uma versão).

O mercado tem serviços prontos para isso (LaunchDarkly, Unleash, Flagsmith, AWS AppConfig). A pergunta é construir ou
usar um deles.

## Decisão

**Um módulo próprio**, com a mesma arquitetura de portas e adaptadores do resto do projeto:

- **porta `FeatureFlags`** (`isEnabled`, `evaluateAll`): quem usa uma flag só conhece isto;
- **adapter `PostgresFeatureFlags`**: lê as regras (poucas) de uma tabela, com cache de 5 s, e avalia localmente;
- **regra pura `evaluate()`**, nesta ordem: flag inexistente → kill switch (vence tudo) → restrições (plataforma,
  versão mínima) → lista de usuários → porcentagem pelo bucket `sha256(flagKey:userId) mod 100`;
- **fail-closed:** sem conseguir ler a configuração, toda flag fica desligada (o contrário da versão mínima, ADR-0008:
  lá a falha deixa passar);
- **`GET /me/features`** devolve só o resultado; a regra fica no servidor;
- **comando `npm run feature-flag`** com validação e auditoria, como o `app-version`.

## Alternativas consideradas

| Alternativa | A favor | Por que não (agora) |
|---|---|---|
| **LaunchDarkly** | Interface para produto e marketing, segmentação rica, experimentos com estatística, SDKs com streaming | Custo por assento e por volume; uma dependência externa no caminho de toda requisição (mitigada pelo cache do SDK); e o objetivo do projeto é entender o mecanismo |
| **Unleash / Flagsmith** (open source, auto-hospedado) | Interface pronta, sem custo de licença | Mais um serviço para operar (banco próprio, atualização, alta disponibilidade) para um punhado de flags |
| **AWS AppConfig** | Gerenciado, versionado, com deploy gradual da própria configuração e rollback | Amarra a API à AWS por um valor que o Postgres já guarda; sem avaliação por usuário pronta (é configuração, não flag com segmentação) |
| **Flag em variável de ambiente** | Trivial | Mudar exige deploy: perde o "desligar em segundos" |
| **Avaliar no app** (o app recebe as regras) | Sem chamada ao abrir | Expõe a lista de testadores e as porcentagens a quem ler o tráfego, e mudar a lógica exige versão nova do app |

## Consequências

**Positivas**
- Nenhuma dependência externa; a avaliação é local (sem chamada de rede por requisição) e testável como função pura.
- As propriedades do rollout são verificadas por teste (determinístico, monotônico, independente entre flags).
- Trocar por um serviço gerenciado é escrever outro adapter da porta, sem mexer em quem usa as flags.

**Negativas**
- **Sem interface:** só um engenheiro com acesso ao banco muda uma flag (pelo comando).
- **Sem experimentos:** a flag divide os usuários, mas a comparação entre os grupos (o "a variante B converteu mais?")
  é feita à mão, pelas métricas (ver a 14.7).
- **Segmentação simples:** usuário, plataforma e versão. Sem país, plano, data de cadastro, atributos arbitrários.
- **Até 5 s de propagação** de uma mudança (o cache por réplica), inclusive do kill switch.

## Revisitar quando

- **Produto ou marketing precisarem mudar flags sem um engenheiro**, ou o número de flags passar de algumas dezenas:
  aí a interface e a gestão do ciclo de vida das flags (quem criou, quando remover) de um serviço pronto compensam.
- **Experimentos (A/B) virarem rotina:** a estatística embutida de um serviço evita conclusões erradas tiradas à mão.
- **Segmentação por atributos de negócio** (plano, país): as regras deixariam de caber num modelo de cinco campos.

## Evidência

- A ordem das regras e as propriedades do bucket com 10 mil usuários simulados; **mutações:** sem o nome da flag no
  hash, o teste de independência falha; com a lista de usuários antes do kill switch, o teste do kill switch falha:
  [`feature-flags.spec.ts`](../../test/unit/feature-flags.spec.ts).
- Comando, auditoria e CHECK no banco: [`feature-flag-admin.spec.ts`](../../test/integration/feature-flag-admin.spec.ts).
- `GET /me/features` por usuário e por app, e o kill switch valendo sem reiniciar:
  [`feature-flags.e2e-spec.ts`](../../test/e2e/feature-flags.e2e-spec.ts).
