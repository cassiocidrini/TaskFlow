import { NOTIFICATIONS_DLT } from '../modules/notifications/consumer/notifications.consumer';
import { NOTIFICATIONS_GROUP } from '../modules/notifications/consumer/notifications.handler';
import { REPORTS_DLT } from '../modules/reports/consumer/reports.consumer';
import { REPORTS_GROUP } from '../modules/reports/consumer/reports.handler';

/** Como cada consumer group se recupera do que foi para o DLT. */
export type RedrivePolicy =
  | { dltTopic: string; redrivable: true }
  | { dltTopic: string; redrivable: false; instead: string };

/**
 * Política de redrive por consumer group (Módulo 13.6c). Cada grupo DECLARA se o redrive funciona para ele, como
 * declara `acceptsReplay`: grupo novo sem entrada aqui não pode ser reenviado (o comando recusa).
 *
 * O `reports` recusa de propósito: a mensagem reenviada chega DEPOIS das versões mais novas da tarefa, e a guarda de
 * versão a descartaria como duplicata. O redrive "funcionaria" sem efeito nenhum, o pior tipo de falha. Para uma
 * projeção com guarda de versão, a recuperação é reconstruir a partir do Event Store.
 */
export const REDRIVE_POLICIES: Readonly<Record<string, RedrivePolicy>> = {
  [NOTIFICATIONS_GROUP]: { dltTopic: NOTIFICATIONS_DLT, redrivable: true },
  [REPORTS_GROUP]: {
    dltTopic: REPORTS_DLT,
    redrivable: false,
    instead:
      'a guarda de versão do reports descartaria a mensagem reenviada (ela chega depois das versões mais novas da tarefa). Use o runbook "Reconstruir uma projeção a partir do Event Store" (Módulo 13.6b)',
  },
};
