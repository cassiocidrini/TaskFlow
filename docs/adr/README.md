# Architecture Decision Records (ADRs)

Um ADR registra **uma** decisão de arquitetura: o contexto em que foi tomada, o que se decidiu, as alternativas
recusadas e as consequências, inclusive as ruins. Os [módulos](../modules/README.md) explicam **como** cada parte
funciona; os ADRs registram **por que** ela é assim e **quando** a decisão deixaria de valer.

| # | Decisão | Status | Módulo |
|---|---|---|---|
| [0001](0001-kafka-como-transporte-de-eventos.md) | Kafka (KRaft) como transporte dos eventos de integração | Aceito | 13.1 |
| [0002](0002-transactional-outbox-com-relay-por-polling.md) | Transactional Outbox, com relay por polling e advisory lock | Aceito | 13.2 · 13.3 · 13.6b |
| [0003](0003-chave-de-particao-por-tarefa.md) | Chave de partição = `taskId` (ordem por tarefa) | Aceito | 13.3 |
| [0004](0004-evento-de-integracao-separado-do-dominio.md) | Evento de integração separado do de domínio, com contrato versionado | Aceito | 13.2 · 13.4 |
| [0005](0005-idempotencia-no-consumer.md) | Idempotência no consumer: tabela de marcas ou versão do agregado | Aceito | 13.4 · 13.6a · 13.6c |
| [0006](0006-retry-classificado-e-dlt-por-grupo.md) | Retry classificado e DLT por consumer group; sem DLQ no relay | Aceito | 13.5 · 13.6c |
| [0007](0007-kafka-para-fatos-sqs-para-trabalho.md) | Kafka para fatos, SQS para trabalho (envio dentro da transação) | Aceito | 13.7 |

## Formato

O de Michael Nygard, com duas seções a mais:

- **Contexto:** a situação e as forças em jogo, sem a decisão.
- **Decisão:** o que foi decidido, na voz ativa ("usamos X").
- **Alternativas consideradas:** cada uma com o motivo de não ter sido escolhida.
- **Consequências:** o que melhora **e** o que piora. Um ADR sem consequência negativa está escondendo alguma.
- **Revisitar quando:** os gatilhos concretos que invalidariam a decisão (volume, requisito, time, custo).
- **Evidência:** os testes e medições que sustentam a decisão, com links.

## Regras

- **ADR aceito não se edita** (só correção de link ou digitação). Decisão que muda ganha um ADR **novo**, que diz
  "Substitui o ADR-000X"; o antigo passa a "Substituído por ADR-000Y" e continua aqui: o histórico do porquê é o valor.
- **Decisão nova de arquitetura = ADR novo, no mesmo PR do código.** Numeração sequencial, nome em kebab-case.
- **Os ADRs 0001 a 0006 foram registrados em 24/11/2026**, depois das decisões (tomadas entre 09 e 10/11/2026, nas
  etapas do Módulo 13). A data da decisão e a do registro aparecem separadas em cada um.
