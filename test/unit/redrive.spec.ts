/**
 * Redrive do DLT: a decisão por mensagem (`decideRedrive`) e a política por grupo — Módulo 13.6c.
 *
 * Protege:
 * - por padrão, só `exhausted` volta (provável bug corrigido); `permanent` (contrato violado) só com a flag;
 * - a mensagem reenviada é a ORIGINAL: chave, corpo e headers (inclusive `event-id`, que mantém a idempotência), sem
 *   os `dlt-*`, mais `redrive-group` (só este grupo processa);
 * - mensagem de outro grupo, ou sem tópico de origem, é pulada;
 * - o `reports` RECUSA redrive (a guarda de versão o descartaria) e aponta o runbook; grupo desconhecido também.
 */
import { Logger } from '@nestjs/common';
import {
  DltRedriver,
  RedriveRefusedError,
} from '../../src/redrive/dlt-redriver';
import {
  decideRedrive,
  type DltMessage,
} from '../../src/redrive/redrive-message';

const NOW = new Date('2026-11-10T21:00:00.000Z');

const dltMessage = (headers: Record<string, string> = {}): DltMessage => ({
  partition: 1,
  offset: '7',
  key: 'task-1',
  value: '{"eventId":"ev-1"}',
  headers: {
    'event-id': 'ev-1',
    'event-type': 'TaskAssigned',
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    'dlt-original-topic': 'taskflow.task-events.v1',
    'dlt-original-partition': '1',
    'dlt-original-offset': '42',
    'dlt-consumer-group': 'notifications',
    'dlt-reason': 'exhausted',
    'dlt-error-message': 'bug no handler',
    'dlt-attempts': '5',
    'dlt-failed-at': '2026-11-10T20:00:00.000Z',
    ...headers,
  },
});

describe('decideRedrive', () => {
  const options = { includePermanent: false, now: NOW };

  it('exhausted: volta ao tópico de origem como a original, sem dlt-*, com redrive-group', () => {
    expect(decideRedrive(dltMessage(), 'notifications', options)).toEqual({
      action: 'redrive',
      topic: 'taskflow.task-events.v1',
      key: 'task-1',
      value: '{"eventId":"ev-1"}',
      headers: {
        'event-id': 'ev-1',
        'event-type': 'TaskAssigned',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        'redrive-group': 'notifications',
        'redriven-at': NOW.toISOString(),
      },
      reason: 'exhausted',
      eventId: 'ev-1',
    });
  });

  it('permanent: pulada por padrão; reenviada com includePermanent', () => {
    const permanent = dltMessage({ 'dlt-reason': 'permanent' });

    expect(decideRedrive(permanent, 'notifications', options)).toMatchObject({
      action: 'skip',
      why: expect.stringContaining('--include-permanent'),
    });
    expect(
      decideRedrive(permanent, 'notifications', {
        ...options,
        includePermanent: true,
      }),
    ).toMatchObject({ action: 'redrive', reason: 'permanent' });
  });

  it('mensagem de outro grupo, ou sem tópico de origem: pulada', () => {
    expect(
      decideRedrive(
        dltMessage({ 'dlt-consumer-group': 'reports' }),
        'notifications',
        options,
      ),
    ).toMatchObject({ action: 'skip' });
    const semOrigem = dltMessage();
    delete semOrigem.headers['dlt-original-topic'];
    expect(decideRedrive(semOrigem, 'notifications', options)).toMatchObject({
      action: 'skip',
      why: 'sem dlt-original-topic',
    });
  });
});

describe('política de redrive', () => {
  // Recusa antes de qualquer conexão: nem Kafka nem banco são tocados
  const redriver = new DltRedriver(
    {} as never,
    ['localhost:1'],
    new Logger('test'),
  );

  it('reports RECUSA, apontando o runbook de reconstrução', async () => {
    const attempt = redriver.redrive({
      group: 'reports',
      requestedBy: 'teste',
    });

    await expect(attempt).rejects.toThrow(RedriveRefusedError);
    await expect(attempt).rejects.toThrow(
      /guarda de versão.*Reconstruir uma projeção/,
    );
  });

  it('grupo sem política: recusa (grupo novo precisa declarar)', async () => {
    await expect(
      redriver.redrive({ group: 'billing', requestedBy: 'teste' }),
    ).rejects.toThrow(/sem política de redrive/);
  });
});
