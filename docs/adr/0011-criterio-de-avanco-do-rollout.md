# ADR-0011: Critério de avanço do rollout da `task-list-with-stats`

- **Status:** Aceito
- **Decisão:** 24/11/2026 (Módulo 14.7) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0010](0010-feature-flags-proprias.md) (as flags e a comparação de variantes feita à mão) ·
  [Módulo 14](../modules/14-api-para-web-e-apps.md)

## Contexto

A listagem de tarefas, a rota mais chamada da API, passa a trazer os números do projeto (`stats`) atrás da flag
`task-list-with-stats`. A mudança tem dois riscos reais: uma consulta a mais em toda primeira página (latência), e
números que dependem de um processo assíncrono (o consumer `reports`: se ele atrasar, o `stats` vem defasado).

Sem um critério escrito ANTES de ligar a flag, a decisão de passar de 10% para 50% vira "parece bom", e a de reverter,
uma discussão no meio do incidente.

## Decisão

**O grupo de controle e a variante são comparados na mesma janela**, só na primeira página (a única que paga a consulta
a mais), pelas métricas `taskflow_task_list_duration{variant, page}` e `taskflow_task_list_requests_total{variant, page,
outcome}`. A comparação é justa porque o bucket da flag sorteia os grupos sem relação com o perfil do usuário e mantém
cada um sempre no mesmo grupo.

**Avançar** (0% → lista interna → 10% → 50% → 100%) quando, numa janela de 24 h com pelo menos 1.000 requisições na
variante:

| Sinal | Critério |
|---|---|
| Latência | **Não** há regressão: regressão = p95 da variante MAIOR que 1,2× o do controle **E** mais de 50 ms acima |
| Erro | Taxa de 5xx da variante no máximo 0,1 ponto percentual acima da do controle |
| Frescor dos números | Lag do consumer `reports` dentro do alerta `ConsumerLagHigh` (o `stats` depende dele) |
| Incidentes | Nenhum alerta crítico no período |

**Reverter (kill switch)** se a latência ou o erro violarem o critério por 15 minutos: os alertas
`TaskListStatsSlower` e `TaskListStatsErrors` (com piso de tráfego de 0,1 req/s na variante) disparam exatamente
nisso, testados com `promtool`. O kill switch desliga sem apagar a regra: corrigido o problema, `--enable` volta ao
mesmo ponto do rollout.

**Remover a flag** depois de 2 semanas em 100% sem violação: o `if`, a métrica por variante, os alertas e a regra
saem. **Flag é dívida técnica:** uma flag esquecida vira um caminho de código que ninguém mais testa nem entende.

## Por que os dois limites juntos (relativo E absoluto)

| Só o relativo (1,2×) | Só o absoluto (+50 ms) | Os dois |
|---|---|---|
| Alerta por ruído em latência baixa: 5 ms contra 7 ms é 1,4×, e 2 ms não importam a ninguém | Não vê a piora proporcional quando a latência é baixa, nem distingue 50 ms em 1 s (5%) de 50 ms em 10 ms (6×) | Cada limite cobre a fraqueza do outro; o teste do `promtool` prova que o ruído de 5 ms não dispara |

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Avançar por tempo** ("uma semana em cada degrau") | O tempo não diz se está bom; uma regressão passaria adiante no prazo |
| **Comparar com a semana anterior** (antes × depois) | Mistura a mudança com tudo o mais que mudou no período (tráfego, outros deploys); o controle simultâneo isola o efeito |
| **Teste estatístico formal** (A/B com p-valor) | O correto para decidir se uma variante CONVERTE mais; aqui a pergunta é "não piorou", e limites operacionais com piso de tráfego respondem com menos aparato. Um serviço de experimentos (ADR-0010) faria isso direito |
| **Só olhar o painel** | Depende de alguém olhar; o alerta transforma o critério em ação |

## Consequências

**Positivas**
- Avançar e reverter são decisões com números escritos antes, não opinião no momento.
- O critério é executável: dois alertas testados e um painel lado a lado (dashboard da API, linha "Rollout").
- A remoção da flag está planejada desde o início.

**Negativas**
- **Limites escolhidos, não derivados de um SLO:** 1,2× e 50 ms são pontos de partida razoáveis para esta rota.
- **Uma métrica e dois alertas por rollout:** cada flag arriscada exigiria o mesmo, e eles saem junto com a flag.
- **O critério não mede o valor da funcionalidade** (o usuário usa os números?), só que ela não piora o sistema.

## Revisitar quando

- **Houver um SLO da listagem:** os limites passam a ser derivados dele (e de *burn rate*).
- **Rollouts arriscados ficarem frequentes:** um mecanismo genérico (métrica por flag e variante) em vez de um por
  funcionalidade, ou o serviço de experimentos do ADR-0010.

## Evidência

- Ao vivo, com a flag em 50%: 40 usuários, 19 caíram em `with-stats` e 21 em `control`; 600 listagens contadas, sem
  sobra; p95 de 4,80 ms contra 4,77 ms (critério cumprido). Com o kill switch, `with-stats` parou de crescer e o tráfego
  novo foi todo para o controle. [Módulo 14](../modules/14-api-para-web-e-apps.md), "Resultados", 14.7.
- Os alertas com `promtool`: regressão real dispara; ruído em latência baixa, tráfego baixo e o período do `for` não
  disparam; erro só na variante, sem nenhum erro no controle, dispara. **Mutação:** sem o `or vector(0)`, esse último
  não dispara: [`alerts.test.yml`](../../prometheus/alerts.test.yml).
