/** Uma mensagem pronta para sair: destino, chave de partição, corpo serializado e headers. */
export interface OutgoingMessage {
  topic: string;
  /** Mesma chave → mesma partição → ordem garantida (no TaskFlow, o `taskId`). */
  key: string;
  /** JSON do evento de integração. */
  value: string;
  headers: Record<string, string>;
}

/**
 * Porta de saída do relay: "entregue estas mensagens ao broker, nesta ordem, e só resolva quando o broker as tiver
 * confirmado". Classe abstrata (e não interface) para servir de token de injeção do Nest, como o `TaskRepository`.
 *
 * Existe para o relay não depender do Kafka: o teste unitário usa um publisher falso, e a etapa 13.7 pode publicar
 * em outro destino (SQS) sem mexer no loop.
 */
export abstract class MessagePublisher {
  /**
   * @throws se qualquer mensagem não for confirmada; o relay trata o lote inteiro como não publicado (at-least-once).
   */
  abstract publish(messages: readonly OutgoingMessage[]): Promise<void>;
}
