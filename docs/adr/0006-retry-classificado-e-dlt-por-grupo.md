# ADR-0006: Retry classificado e DLT por consumer group; sem DLQ no relay

- **Status:** Aceito
- **Decisão:** 10/11/2026 (Módulos 13.5 e 13.6c) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0002](0002-transactional-outbox-com-relay-por-polling.md) · [ADR-0005](0005-idempotencia-no-consumer.md)

## Contexto

Até a 13.4, uma mensagem que sempre falhava travava a sua partição **para sempre**, e ~1/3 das tarefas deixava de
gerar notificação: uma *poison pill* parava um terço do sistema.

A resposta óbvia, "N tentativas e manda para o dead-letter", tem um defeito: durante uma queda do Postgres, **toda**
mensagem falha, e o tópico inteiro iria para o DLT sem que nenhuma mensagem tivesse culpa. O DLT precisa separar
mensagem envenenada de instabilidade.

Os consumers também usam a **ordem por tarefa** ([ADR-0003](0003-chave-de-particao-por-tarefa.md)), o que limita como
o retry pode funcionar.

## Decisão

**Classificar a falha antes de decidir** (`consumer-errors.ts`):

| Classe | Como é reconhecida | O que acontece |
|---|---|---|
| `permanent` | O handler lança `NonRetryableError` (contrato violado, mensagem contraditória) | **DLT na 1ª falha** |
| `infrastructure` | Códigos do Prisma e SQLSTATE do Postgres de banco inalcançável, **medidos** derrubando o banco de quatro jeitos; ou `InfrastructureError` lançada por um adapter (o SQS do push, 13.7) | **Tenta para sempre**, backoff até 30 s. **Nunca** DLT |
| `unknown` | O resto (bug, constraint inesperada) | 5 tentativas (~7,5 s), depois DLT |

**Retry bloqueante, na própria partição:** a mensagem que falha é tentada de novo antes da seguinte, que espera.

**Um DLT por consumer group** (`taskflow.<grupo>-dlt.v1`, 30 dias de retenção): a mensagem original intacta, com o
diagnóstico em headers (`dlt-reason`, `dlt-attempts`, `dlt-error-message`, partição e offset de origem). O **ack do
DLT vem antes do commit do offset**: com o DLT fora, a mensagem não sai da partição.

**Redrive com política por grupo** (13.6c): `npm run redrive -- --group <g>` republica do DLT no tópico de origem com o
header `redrive-group` (só o grupo que falhou processa), só as `exhausted` por padrão, com `--dry-run` e auditoria em
`dlt_redrives`. O `reports` **recusa** o redrive e aponta o runbook de reconstrução
([ADR-0005](0005-idempotencia-no-consumer.md)).

**Sem DLQ no relay da outbox.** Quem produz a mensagem é o nosso código, com contrato testado; as falhas possíveis na
publicação são de infraestrutura e atingem **todas** as mensagens. Uma DLQ ali estacionaria a outbox inteira e
esconderia a falha. No lugar: o alerta de idade da outbox, `attempts` e `last_error` na linha, e um runbook.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **N tentativas e DLT, sem classificar** | Esvazia o tópico no DLT numa queda do banco. Medido com a classificação desligada: **6 de 40 eventos legítimos no DLT em 45 s** de banco fora |
| **Tópicos de retry** (`retry-5s`, `retry-1m`) | Não travam a partição, mas **quebram a ordem por tarefa**: o `TaskCompleted` passaria na frente do `TaskAssigned` que espera |
| **Um DLT compartilhado** (`task-events.v1.dlt`) | A falha é do consumer, não do evento: o outro grupo processa a mesma mensagem normalmente, e reprocessar a partir de um DLT compartilhado reentregaria a todos |
| **Estacionar a chave** (segurar as seguintes da mesma tarefa até resolver) | Preserva a ordem; complexidade sem caso real aqui. Registrado, não implementado |
| **Redrive automático** | Uma mensagem que falhou por bug voltaria a falhar antes do deploy da correção. O redrive é decisão de quem opera, depois do `--dry-run` |
| **DLQ no relay** | Ver acima: falhas de infraestrutura, não de mensagem |

## Consequências

**Positivas**
- Uma *poison pill* custa **uma** mensagem desviada, não 1/3 do sistema.
- Uma queda do banco não manda nada ao DLT: o sinal é a métrica de retries `infrastructure` e o lag, com o alerta
  `ConsumerDatabaseUnavailable`.
- O DLT faz parte de um ciclo de recuperação (inspecionar, corrigir, redrive auditado), não é um cemitério.

**Negativas**
- **O DLT troca ordem por disponibilidade:** com um `TaskAssigned` desviado, o `TaskCompleted` seguinte passa sem ele, e
  ninguém é notificado da conclusão. A mensagem reenviada pelo redrive chega fora de ordem.
- **Banco fora para a partição inteira**, por quanto tempo durar; a volta leva até 30 s (o teto do backoff).
- **A contagem de tentativas fica em memória:** um restart ou rebalance recomeça a contagem de uma falha `unknown`. Só
  atrasa o DLT, não perde nada.
- **Sem DLQ no relay, uma mensagem com erro permanente trava a outbox** até alguém aplicar o runbook.

## Revisitar quando

- **Um consumer em que a ordem não importa:** tópicos de retry dariam vazão sem travar a partição.
- **Mensagens perdidas por desvio ficarem caras** (consumidor financeiro): estacionar a chave em vez de seguir.
- **O relay passar a publicar conteúdo de terceiros**, ou aparecer uma falha permanente por mensagem na publicação:
  aí uma DLQ no relay passa a ter o que estacionar.

## Evidência

- Envenenada vai ao DLT na 1ª falha, intacta e com diagnóstico, e a partição segue; `unknown` vai depois de
  `maxAttempts`; **banco fora passa do limite e não vai ao DLT**; DLT fora não perde a mensagem:
  [`dead-letter.streaming-spec.ts`](../../test/streaming/dead-letter.streaming-spec.ts).
- Classificação com os formatos reais de erro do Prisma: [`consumer-errors.spec.ts`](../../test/unit/consumer-errors.spec.ts).
- Redrive só para o grupo que falhou, com auditoria: [`redrive.streaming-spec.ts`](../../test/streaming/redrive.streaming-spec.ts).
- Detalhes e o runbook da outbox: [Módulo 13](../modules/13-mensageria-kafka.md), "Retry e dead-letter topic" e "Por
  que não há DLQ no relay".
