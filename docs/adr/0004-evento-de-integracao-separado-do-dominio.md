# ADR-0004: Evento de integração separado do de domínio, com contrato versionado

- **Status:** Aceito
- **Decisão:** 10/11/2026 (Módulos 13.2 e 13.4) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0001](0001-kafka-como-transporte-de-eventos.md) · [ADR-0007](0007-kafka-para-fatos-sqs-para-trabalho.md)
  (o mesmo princípio aplicado ao contrato da fila de push)

## Contexto

O Event Store guarda **eventos de domínio** (`task.events.ts`): o mínimo para o agregado reconstruir o próprio estado.
Eles evoluem junto com o agregado, com `schemaVersion` e *upcaster* na leitura, e só este serviço os lê.

Com o Kafka, outros processos passam a ler os eventos. Se o tópico levasse o payload de domínio, **qualquer refatoração
do agregado quebraria quem consome**, e um campo interno passaria a ser contrato público sem ninguém decidir isso.
Além disso, os eventos de domínio não trazem tudo o que um consumidor precisa: o `TaskCompleted` não tem o
`projectId`, e um relatório por projeto teria que consultar a nossa API a cada evento.

## Decisão

**Dois modelos, com um mapeamento explícito entre eles.** Cada evento de domínio vira um **evento de integração**
(`task.integration-events.ts`), o contrato público do tópico:

- **Envelope fixo:** `eventId`, `eventType`, `eventVersion`, `occurredAt`, `aggregateId`, `aggregateVersion`,
  `projectId`, `actorId`, `correlationId`, mais o `data` do tipo. Nomes inspirados no CloudEvents, sem adotar a
  especificação inteira.
- **Mapeamento campo a campo, nunca `...spread`:** um campo novo no domínio não vaza para o tópico sozinho.
- **`switch` exaustivo e versões em `Record` exaustivo:** um evento de domínio novo sem contrato **não compila**. Evento
  interno pode ser mapeado para `null` (não publicado).
- **Versionamento:** mudança compatível (campo opcional novo) mantém a versão; incompatível incrementa `eventVersion`
  ou cria o tópico `.v2`. O `eventVersion` é do contrato e não tem relação com o `schemaVersion` interno.

**Do lado de quem consome, leitor tolerante com contrato copiado:**

- cada consumidor tem a **sua cópia** do formato (`task-event.message.ts` no `notifications` e no `reports`; a Lambda
  do push tem a dela) e **não importa** o código do produtor;
- valida só o que usa (zod nos consumers; à mão na Lambda, sem dependências): campo novo é aceito e descartado, tipo
  desconhecido é ignorado, `eventVersion` maior que o suportado é ignorado com aviso, e mensagem malformada de um tipo
  tratado é erro permanente (DLT, [ADR-0006](0006-retry-classificado-e-dlt-por-grupo.md)).

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Publicar o payload do Event Store** | Detalhe interno vira contrato público; o agregado deixa de poder evoluir sem coordenar com os consumidores |
| **Schema registry** (Avro, Protobuf ou JSON Schema, com checagem de compatibilidade) | O jeito certo com vários produtores, linguagens ou times. Aqui há um produtor, em TypeScript, e o contrato é protegido por testes; o registry seria mais um serviço para operar sem ganho hoje |
| **Consumer importando o tipo do produtor** | Mudar o produtor quebraria o build do consumer; entre serviços de verdade, nem seria possível (repositórios e deploys diferentes) |
| **Especificação CloudEvents completa** | Útil para integrar com ferramentas que a falam; sem esse caso, o envelope próprio é mais simples. A migração é direta, porque os conceitos já batem |

## Consequências

**Positivas**
- O agregado evolui livremente: só o mapper conhece os dois lados.
- Consumidores não consultam a API: o envelope traz `projectId`, `actorId` e `aggregateVersion`, que permitem
  idempotência por versão ([ADR-0005](0005-idempotencia-no-consumer.md)) e rastreio (`correlationId`).
- Um produtor que mande um campo a mais não quebra nenhum consumidor.

**Negativas**
- **O contrato existe em quatro lugares** (produtor, dois consumers e a Lambda). A divergência é pega por testes de cada
  lado, e não pelo broker.
- **Ignorar `eventVersion` desconhecido troca correção por disponibilidade:** uma notificação se perde, mas a partição
  não trava. Num consumidor financeiro, a escolha certa seria o contrário (falhar e parar).
- **Nenhuma checagem central de compatibilidade:** um produtor descuidado pode publicar uma mudança incompatível sem
  incrementar a versão, e só os testes dos consumidores acusam.

## Revisitar quando

- **Um segundo produtor**, outro time ou outra linguagem passar a publicar no tópico: adotar um schema registry, com a
  checagem de compatibilidade no CI ou no próprio broker.
- **Um consumidor com requisito de correção estrita** (financeiro, auditoria): para ele, `eventVersion` desconhecido
  deve ser erro, não `ignored`.

## Evidência

- Campo do domínio fora do contrato não vaza para o tópico; opcionais ausentes são omitidos:
  [`task.integration-events.spec.ts`](../../test/unit/task.integration-events.spec.ts).
- Leitor tolerante (campo novo aceito, tipo ignorado, versão mais nova ignorada): [`task-event.message.spec.ts`](../../test/unit/task-event.message.spec.ts).
- Contrato da Lambda (só os campos conhecidos, versão desconhecida recusada): [`push-sender.spec.ts`](../../test/unit/push-sender.spec.ts).
- Detalhes: [Módulo 13](../modules/13-mensageria-kafka.md), "Evento de domínio × evento de integração".
