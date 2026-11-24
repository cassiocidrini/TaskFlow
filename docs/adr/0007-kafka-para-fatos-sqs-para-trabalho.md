# ADR-0007: Kafka para fatos, SQS para trabalho (envio dentro da transação)

- **Status:** Aceito
- **Decisão:** 24/11/2026 (Módulo 13.7) · **Registro:** 24/11/2026
- **Relacionados:** [ADR-0001](0001-kafka-como-transporte-de-eventos.md) · [ADR-0005](0005-idempotencia-no-consumer.md) ·
  [ADR-0006](0006-retry-classificado-e-dlt-por-grupo.md)

## Contexto

O consumer `notifications` grava uma notificação quando uma tarefa é atribuída ou concluída. O passo seguinte é
mandar um **push** para o celular do destinatário, por um provedor externo (APNs, FCM) que falha, limita taxa e cobra.

Esse envio tem características diferentes dos eventos do tópico:

- precisa acontecer **uma vez**, por alguém, e não ser relido num replay nem por outro consumidor;
- precisa de **retry por mensagem**, sem travar as outras;
- não tem ordem.

E existe um dual-write a evitar: gravar a notificação no Postgres e enfileirar o envio são duas escritas em dois
sistemas.

## Decisão

**O critério:** um evento no **Kafka** diz "algo aconteceu" (um **fato**, que quem quiser lê, inclusive no futuro);
uma mensagem no **SQS** diz "alguém precisa fazer isto uma vez" (um **trabalho**, apagado depois de feito). A
notificação gravada é o fato; o push é o trabalho.

**O envio do pedido entra na transação do consumer, como a última escrita antes do COMMIT** (porta `PushQueue`,
adapter `SqsPushQueue`):

| Falha | O que acontece |
|---|---|
| SQS fora | `InfrastructureError` → rollback de marca e notificação → retry infinito, nunca DLT ([ADR-0006](0006-retry-classificado-e-dlt-por-grupo.md)) |
| COMMIT falha depois do envio | O Kafka reentrega; o pedido é enfileirado de novo com o **mesmo `pushId`** (= `eventId`) e a Lambda descarta a duplicata |

**Uma Lambda (`push-sender`) consome a fila e é idempotente:** reserva condicional no DynamoDB (`IN_PROGRESS` com prazo,
depois `COMPLETED` com TTL), `batchItemFailures` com `ReportBatchItemFailures` no event source mapping, e DLQ depois de
3 recebimentos.

**Detalhes que fazem parte da decisão:**
- **Fila standard**, não FIFO: sem ordem a preservar, e a idempotência está na Lambda.
- **Chave de idempotência = `eventId`**, e não o id da notificação (gerado de novo a cada tentativa).
- **Tempos amarrados:** timeout da Lambda (10 s) < prazo da reserva (30 s) < visibility timeout (60 s).
- **Orçamento do envio dentro da transação:** 2 tentativas de 1,5 s e um `AbortSignal` de 3,5 s, menor que os 5 s da
  transação do Prisma.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Uma segunda outbox** (`push_requests` + relay para o SQS) | A mais forte: o push não depende do SQS estar no ar na hora. Custa outro processo para operar só para garantir o que a idempotência da Lambda já garante |
| **Enviar depois do COMMIT** | Um crash entre o COMMIT e o envio perde o push para sempre: a reentrega bate em `processed_events` e sai como duplicata |
| **Push direto do consumer**, sem fila | Acopla a partição do Kafka à latência e às falhas do provedor; sem retry por mensagem nem DLQ |
| **Outro consumer group lendo o tópico para enviar push** | Quem decide **a quem** notificar é o contexto de notificações (pela projeção local); um segundo grupo duplicaria essa regra |
| **SQS FIFO** | Vazão limitada e deduplicação só numa janela de 5 minutos, que não substitui a idempotência |

## Consequências

**Positivas**
- Cada sistema no que faz melhor: o Kafka guarda e redistribui o fato; o SQS faz retry por mensagem, DLQ e escala a
  Lambda.
- O replay não gera push (o `notifications` ignora replay): o histórico pode ser republicado sem avisar ninguém de novo.
- Uma mensagem ruim no lote não reenvia as boas.

**Negativas**
- **Com o SQS fora, as notificações também param:** o envio está na transação, então a partição espera a fila voltar.
- **A transação do Postgres fica aberta durante a chamada ao SQS** (até 3,5 s no pior caso).
- **Push duplo ainda possível** se a Lambda morrer entre o provedor aceitar e a marca `COMPLETED`. A última defesa seria
  a chave de colapso do provedor (`apns-collapse-id`, `collapse_key`).
- **O trace para no SQS:** o `traceparent` não segue na mensagem da fila.
- **Integração com a AWS testada só manualmente** (LocalStack exige token, que não vai para o CI).
- **Runtime `nodejs22.x`** na Lambda, porque o provider AWS 5.x travado no lock não aceita o `nodejs24.x`.

## Revisitar quando

- **O push virar crítico** (aviso de segurança, confirmação de transação), ou parar as notificações durante uma queda
  do SQS deixar de ser aceitável: migrar para a segunda outbox.
- **Houver mais de um tipo de trabalho** saindo das notificações (e-mail, SMS): um tópico SNS na frente das filas, uma
  por canal.
- **O provider AWS subir para a 6.x:** levar a Lambda para `nodejs24.x`.

## Evidência

- Pedido enfileirado dentro da transação; fila fora desfaz marca e notificação e a reentrega faz tudo; duplicata não
  reenfileira: [`notifications-handler.spec.ts`](../../test/integration/notifications-handler.spec.ts).
- Adapter contra falhas reais de rede: conexão recusada e servidor que aceita e não responde (**mutação:** sem o
  `AbortSignal` e com o timeout só avisando, o teste estoura o tempo): [`sqs-push-queue.spec.ts`](../../test/unit/sqs-push-queue.spec.ts).
- Lambda: lote misto devolve só a falha, duplicata não reenvia, reserva em andamento volta à fila, marca que falha
  depois do envio não reenvia: [`push-sender.spec.ts`](../../test/unit/push-sender.spec.ts).
- No LocalStack: `[push-fail]` com `receiveCount` 1, 2, 3 e então DLQ; SQS pausado = API 201, 0 notificações durante
  a queda, 0 no DLT, push enviado na volta. [Módulo 13](../modules/13-mensageria-kafka.md), "Resultados obtidos", 13.7.
