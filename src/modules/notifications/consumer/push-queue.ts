import { Logger } from '@nestjs/common';
import type { NotificationType } from '@prisma/client';

/** Versão do corpo da mensagem na fila de push. Mudança incompatível = versão nova, lida pela Lambda lado a lado. */
export const PUSH_REQUEST_VERSION = 1;

/**
 * Pedido de envio de push: o TRABALHO que o contexto de notificações entrega à fila (Módulo 13.7).
 *
 * É um contrato público entre dois deployables (este consumer e a Lambda `push-sender`), como o evento de integração
 * do tópico: a Lambda tem a SUA cópia do formato (`lambdas/push-sender/push-request.ts`) e não importa este arquivo.
 */
export interface PushRequest {
  version: typeof PUSH_REQUEST_VERSION;
  /**
   * Chave de idempotência do envio = `eventId` do evento de origem. NÃO o id da notificação: esse é gerado a cada
   * tentativa (uma transação desfeita e refeita cria outro), e duas tentativas virariam dois pushes. O `eventId` é o
   * mesmo em toda reentrega do Kafka.
   */
  pushId: string;
  /** Destinatário. Os dispositivos dele são problema do provedor de push (registro de dispositivos: Módulo 14). */
  userId: string;
  type: NotificationType;
  body: string;
  taskId: string;
  projectId: string;
  /** Quando o pedido foi feito: deixa a Lambda descartar push velho demais, se um dia precisar. */
  requestedAt: string;
}

/**
 * Porta de saída: "este push precisa ser enviado UMA vez, por alguém". Classe abstrata para servir de token de
 * injeção do Nest, como o `MessagePublisher` do relay.
 *
 * O contrato que o `NotificationsHandler` depende: `enqueue` só resolve quando a fila CONFIRMOU a mensagem, e falha
 * com `InfrastructureError` quando não confirmou (o handler roda isso dentro da transação, e a falha desfaz tudo).
 */
export abstract class PushQueue {
  abstract enqueue(request: PushRequest): Promise<void>;
}

/**
 * Adapter usado quando `PUSH_QUEUE_URL` não está definida: dev sem AWS, CI e a suíte de streaming. Não envia nada,
 * só registra em debug. A notificação continua sendo gravada; o que fica de fora é só o push.
 */
export class DisabledPushQueue extends PushQueue {
  private readonly logger = new Logger(DisabledPushQueue.name);

  enqueue(request: PushRequest): Promise<void> {
    this.logger.debug(
      `Push ${request.pushId} não enfileirado: PUSH_QUEUE_URL não configurada`,
    );
    return Promise.resolve();
  }
}
