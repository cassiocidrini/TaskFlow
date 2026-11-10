/**
 * Leitor tolerante do consumer de relatórios (`parseReportEvent`) — Módulo 13.6a.
 *
 * Protege o contrato que ESTE consumer lê, independente do de notificações: trata o `TaskStatusChanged` (que o de
 * notificações ignora), não exige o título, descarta campo novo, ignora tipo ou versão desconhecidos sem travar a
 * partição, e trata mensagem malformada de um tipo que usa como `NonRetryableError` (vai ao DLT na 1ª falha).
 */
import { NonRetryableError } from '../../src/common/messaging/consumer-errors';
import {
  InvalidReportMessageError,
  parseReportEvent,
} from '../../src/modules/reports/consumer/task-event.message';

const envelope = {
  eventId: '6f1d4c9e-2b7a-4e0f-9c3d-1a2b3c4d5e6f',
  eventVersion: 1,
  occurredAt: '2026-11-10T10:00:00.000Z',
  aggregateId: '370b268e-18ba-444c-ae17-2716b0269232',
  aggregateVersion: 3,
  projectId: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87',
  actorId: 'c5afce1e-dbd3-4606-a69f-cc930471cef8',
};
const json = (value: object) => JSON.stringify(value);

describe('parseReportEvent', () => {
  it('lê o TaskStatusChanged (o consumer de notificações o ignora)', () => {
    const parsed = parseReportEvent(
      json({
        ...envelope,
        eventType: 'TaskStatusChanged',
        data: { from: 'PENDING', to: 'IN_PROGRESS' },
      }),
    );

    expect(parsed).toMatchObject({
      kind: 'event',
      event: { eventType: 'TaskStatusChanged', aggregateVersion: 3 },
    });
  });

  it('TaskCreated sem título é aceito (este consumer não usa o título) e campo novo é descartado', () => {
    const parsed = parseReportEvent(
      json({
        ...envelope,
        eventType: 'TaskCreated',
        data: { priority: 'HIGH', campoNovo: true },
      }),
    );

    expect(parsed.kind).toBe('event');
  });

  it('tipo desconhecido e versão de contrato nova: ignored, sem erro', () => {
    expect(
      parseReportEvent(
        json({ ...envelope, eventType: 'TaskArchived', data: {} }),
      ).kind,
    ).toBe('ignored');
    expect(
      parseReportEvent(
        json({
          ...envelope,
          eventType: 'TaskCreated',
          eventVersion: 2,
          data: {},
        }),
      ).kind,
    ).toBe('ignored');
  });

  it.each([
    [
      'sem aggregateVersion (a guarda de idempotência)',
      { aggregateVersion: undefined },
    ],
    ['status fora do contrato', { data: { from: 'PENDING', to: 'DONE' } }],
  ])(
    '%s: InvalidReportMessageError, que é NonRetryableError',
    (_name, override) => {
      const call = () =>
        parseReportEvent(
          json({
            ...envelope,
            eventType: 'TaskStatusChanged',
            data: { from: 'PENDING', to: 'IN_PROGRESS' },
            ...override,
          }),
        );

      expect(call).toThrow(InvalidReportMessageError);
      expect(call).toThrow(NonRetryableError);
    },
  );

  it('corpo que não é JSON: InvalidReportMessageError', () => {
    expect(() => parseReportEvent('{')).toThrow(InvalidReportMessageError);
  });
});
