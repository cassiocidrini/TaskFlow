import type { PushRequest } from './push-request';

/**
 * Porta para o provedor de push (FCM no Android, APNs no iOS). A Lambda só depende disto; trocar o simulado por um
 * real é escrever outro adapter, sem tocar no processamento do lote.
 */
export interface PushProvider {
  /** Resolve quando o provedor ACEITOU o envio; rejeita com o motivo quando não aceitou. */
  send(push: PushRequest): Promise<void>;
}

/** Marcador que força falha no provedor simulado: crie uma tarefa com isto no título para ver a DLQ funcionando. */
export const SIMULATED_FAILURE_MARKER = '[push-fail]';

/**
 * Provedor SIMULADO: não fala com Apple nem Google (este projeto não tem registro de dispositivos; isso é do Módulo
 * 14). Registra o envio no log e falha quando o texto do push contém {@link SIMULATED_FAILURE_MARKER}, para a falha
 * parcial do lote e a DLQ serem demonstráveis.
 *
 * Num provedor real, o `pushId` iria na chave de colapso (`apns-collapse-id`, `collapse_key` do FCM): se o mesmo push
 * escapar duas vezes da idempotência, o aparelho mostra um só.
 */
export class SimulatedPushProvider implements PushProvider {
  constructor(
    private readonly log: (message: string, fields: object) => void,
  ) {}

  send(push: PushRequest): Promise<void> {
    if (push.body.includes(SIMULATED_FAILURE_MARKER)) {
      return Promise.reject(
        new Error('provedor de push recusou o envio (falha simulada)'),
      );
    }
    this.log('push enviado (simulado)', {
      pushId: push.pushId,
      userId: push.userId,
      type: push.type,
    });
    return Promise.resolve();
  }
}
