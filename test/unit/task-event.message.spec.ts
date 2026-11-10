/**
 * Leitura do contrato pelo consumer de notificações (`parseTaskEvent`) — Módulo 13.4.
 *
 * Protege o "leitor tolerante": campo novo no evento não quebra; tipo que não interessa e versão de contrato mais
 * nova são IGNORADOS (sem travar a partição); e mensagem malformada de um tipo que o consumer TRATA falha alto
 * (`InvalidMessageError`), em vez de sumir em silêncio com uma notificação junto.
 */
import {
  InvalidMessageError,
  parseTaskEvent,
} from '../../src/modules/notifications/consumer/task-event.message';

const valid = {
  eventId: '66666666-6666-4666-8666-666666666666',
  eventType: 'TaskAssigned',
  eventVersion: 1,
  occurredAt: '2026-11-10T12:00:00.000Z',
  aggregateId: '44444444-4444-4444-8444-444444444444',
  aggregateVersion: 2,
  projectId: '55555555-5555-4555-8555-555555555555',
  actorId: '11111111-1111-4111-8111-111111111111',
  correlationId: 'corr-1',
  data: { assigneeId: '22222222-2222-4222-8222-222222222222' },
};
const json = (value: unknown) => JSON.stringify(value);

describe('parseTaskEvent', () => {
  it('deve devolver o evento tipado de um contrato válido', () => {
    expect(parseTaskEvent(json(valid))).toEqual({
      kind: 'event',
      event: valid,
    });
  });

  it('leitor tolerante: campo NOVO no evento ou no data é aceito (e descartado)', () => {
    const parsed = parseTaskEvent(
      json({
        ...valid,
        newEnvelopeField: 1,
        data: { ...valid.data, reason: 'férias' },
      }),
    );

    expect(parsed).toEqual({ kind: 'event', event: valid });
  });

  it('tipo que não gera notificação: ignorado', () => {
    expect(
      parseTaskEvent(
        json({
          ...valid,
          eventType: 'TaskStatusChanged',
          data: { from: 'PENDING', to: 'IN_PROGRESS' },
        }),
      ),
    ).toEqual({
      kind: 'ignored',
      reason: 'tipo TaskStatusChanged não gera notificação',
    });
  });

  it('versão de contrato mais nova que a suportada: ignorada, sem tentar adivinhar o formato', () => {
    expect(parseTaskEvent(json({ ...valid, eventVersion: 2 }))).toMatchObject({
      kind: 'ignored',
    });
  });

  it.each([
    ['corpo vazio', null],
    ['JSON inválido', '{nao-e-json'],
    ['sem eventType', json({ ...valid, eventType: undefined })],
    [
      'assigneeId que não é UUID',
      json({ ...valid, data: { assigneeId: 'ana' } }),
    ],
    ['sem eventId', json({ ...valid, eventId: undefined })],
  ])(
    'malformada (%s): InvalidMessageError, nunca ignorada em silêncio',
    (_caso, value) => {
      expect(() => parseTaskEvent(value)).toThrow(InvalidMessageError);
    },
  );
});
