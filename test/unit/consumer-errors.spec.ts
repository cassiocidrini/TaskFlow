/**
 * Classificação das falhas do consumer e a decisão retry × DLT (Módulo 13.5).
 *
 * Protege a regra que separa "mensagem envenenada" de "instabilidade":
 * - erro de banco NUNCA leva ao DLT, nem depois de 100 tentativas (senão 5 min de Postgres fora esvaziariam o
 *   tópico no DLT);
 * - `NonRetryableError` (contrato violado) vai ao DLT na 1ª falha;
 * - o resto tenta `maxAttempts` vezes, com backoff exponencial e teto.
 *
 * Os erros de banco são os formatos REAIS do Prisma 7 + adapter-pg, capturados derrubando o Postgres de verdade
 * (porta fechada, `docker stop`, `docker pause` e `pg_terminate_backend`; Módulo 13, problema 21). Um erro montado à
 * mão com o formato que a gente imagina passaria aqui e falharia em produção.
 */
import { Prisma } from '@prisma/client';
import {
  classifyFailure,
  DEFAULT_MAX_ATTEMPTS,
  isInfrastructureError,
  MAX_RETRY_BACKOFF_MS,
  nextStep,
  NonRetryableError,
  retryDelay,
} from '../../src/common/messaging/consumer-errors';
import { InvalidMessageError } from '../../src/modules/notifications/consumer/task-event.message';

const prismaError = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('falha', {
    code,
    clientVersion: '7.10.0',
    meta,
  });

/** Banco inalcançável: porta fechada ou container parado (`docker stop`) */
const unreachable = prismaError('P1001', {
  driverAdapterError: {
    name: 'DriverAdapterError',
    cause: { kind: 'DatabaseNotReachable', host: '127.0.0.1', port: 5432 },
  },
});
/** Rede travada (`docker pause`): a transação interativa não abre em 2 s */
const transactionNotStarted = prismaError('P2028', {});
/** Conexão derrubada no meio da query (`pg_terminate_backend`, failover do banco) */
const terminatedMidQuery = prismaError('P2010', {
  driverAdapterError: {
    name: 'DriverAdapterError',
    cause: {
      originalCode: '57P01',
      originalMessage: 'terminating connection due to administrator command',
      kind: 'postgres',
      code: '57P01',
      severity: 'FATAL',
    },
  },
});

describe('isInfrastructureError', () => {
  it.each([
    ['P1001 (banco inalcançável)', unreachable],
    ['P2028 (transação não abriu: rede travada)', transactionNotStarted],
    ['SQLSTATE 57P01 (conexão derrubada no meio)', terminatedMidQuery],
    [
      'SQLSTATE classe 08 (connection exception)',
      prismaError('P2010', {
        driverAdapterError: { cause: { originalCode: '08006' } },
      }),
    ],
    ['P2024 (pool esgotado)', prismaError('P2024')],
    [
      'ECONNREFUSED sem embrulho do Prisma',
      Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
    ],
  ])('%s: é infraestrutura', (_name, error) => {
    expect(isInfrastructureError(error)).toBe(true);
  });

  it.each([
    ['P2002 (unique violation)', prismaError('P2002')],
    [
      'SQLSTATE 23505 no adapter',
      prismaError('P2010', {
        driverAdapterError: { cause: { originalCode: '23505' } },
      }),
    ],
    ['Error comum', new Error('bug')],
    ['valor que não é erro', 'texto'],
    ['null', null],
  ])('%s: NÃO é infraestrutura', (_name, error) => {
    expect(isInfrastructureError(error)).toBe(false);
  });
});

describe('classifyFailure', () => {
  it('InvalidMessageError (contrato violado) é permanente: herda de NonRetryableError', () => {
    expect(classifyFailure(new InvalidMessageError('x'))).toBe('permanent');
    expect(classifyFailure(new NonRetryableError('x'))).toBe('permanent');
  });

  it('erro de banco é infraestrutura; o resto, desconhecido', () => {
    expect(classifyFailure(unreachable)).toBe('infrastructure');
    expect(classifyFailure(new TypeError('bug no handler'))).toBe('unknown');
  });
});

describe('nextStep', () => {
  it('permanente: DLT na 1ª falha, sem tentar de novo', () => {
    expect(nextStep('permanent', 1)).toEqual({ action: 'dead-letter' });
  });

  it('infraestrutura: nunca DLT, nem na 100ª tentativa; espera no teto', () => {
    expect(nextStep('infrastructure', 100)).toEqual({
      action: 'retry',
      delayMs: MAX_RETRY_BACKOFF_MS,
    });
  });

  it(`desconhecido: ${DEFAULT_MAX_ATTEMPTS} tentativas e então DLT`, () => {
    const steps = Array.from({ length: DEFAULT_MAX_ATTEMPTS }, (_, i) =>
      nextStep('unknown', i + 1),
    );

    expect(steps).toEqual([
      { action: 'retry', delayMs: 500 },
      { action: 'retry', delayMs: 1_000 },
      { action: 'retry', delayMs: 2_000 },
      { action: 'retry', delayMs: 4_000 },
      { action: 'dead-letter' },
    ]);
  });

  it('maxAttempts configurável', () => {
    expect(nextStep('unknown', 2, 2)).toEqual({ action: 'dead-letter' });
  });

  it('backoff exponencial com teto de 30 s', () => {
    expect([1, 2, 6, 7, 20].map(retryDelay)).toEqual([
      500, 1_000, 16_000, 30_000, 30_000,
    ]);
  });
});
