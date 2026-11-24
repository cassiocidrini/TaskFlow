/**
 * `Idempotency-Key` (Módulo 14.5): a validação do header, o hash que define "o mesmo pedido" e a regra do 422.
 *
 * Protege:
 * - header ausente = sem idempotência (opcional, para não quebrar os apps instalados); presente e inválido = 400, e não
 *   ignorado em silêncio (o cliente pediu uma garantia);
 * - o hash é o MESMO para o mesmo pedido em qualquer ordem de chaves do JSON, e DIFERENTE se mudar o método, a rota (o
 *   projeto) ou o corpo: senão uma nova tentativa legítima viraria 422, ou um pedido diferente receberia a resposta de
 *   outro;
 * - mesma chave com o mesmo hash devolve a resposta guardada; com outro hash, `IDEMPOTENCY_KEY_REUSED` (422).
 */
import { randomUUID } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  IdempotencyKeyReusedError,
  parseIdempotencyKey,
  requestHash,
} from '../../src/common/idempotency/idempotency-key';
import { IdempotencyStore } from '../../src/common/idempotency/idempotency.store';
import type { Env } from '../../src/config/env.schema';
import type { PrismaService } from '../../src/prisma/prisma.service';

describe('parseIdempotencyKey', () => {
  it('ausente: sem idempotência (o header é opcional)', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it('UUID e outros formatos ASCII visíveis: aceitos como vieram', () => {
    const uuid = randomUUID();
    expect(parseIdempotencyKey(uuid)).toBe(uuid);
    expect(parseIdempotencyKey('pedido:2026-11-24#7')).toBe(
      'pedido:2026-11-24#7',
    );
    expect(parseIdempotencyKey('a'.repeat(255))).toHaveLength(255);
  });

  it.each([
    ['vazia', ''],
    ['longa demais', 'a'.repeat(256)],
    ['com espaço', 'minha chave'],
    ['com quebra de linha (log injection)', 'k\nX-Fake: 1'],
    ['repetida (o Node entrega lista)', ['k1', 'k2']],
  ])('inválida (%s): 400, e não ignorada em silêncio', (_label, raw) => {
    expect(() => parseIdempotencyKey(raw)).toThrow(BadRequestException);
  });
});

describe('requestHash', () => {
  const path = '/projects/p1/tasks';
  const body = {
    title: 'Pagar boleto',
    due: { at: '2026-12-31T23:59:59Z', timezone: 'UTC' },
  };

  it('a ordem das chaves do JSON não muda o hash (é o MESMO pedido)', () => {
    const reordered = {
      due: { timezone: 'UTC', at: '2026-12-31T23:59:59Z' },
      title: 'Pagar boleto',
    };
    expect(requestHash('POST', path, reordered)).toBe(
      requestHash('POST', path, body),
    );
  });

  it('outro corpo, outra rota (outro projeto) ou outro método: outro hash', () => {
    const base = requestHash('POST', path, body);
    expect(
      requestHash('POST', path, { ...body, title: 'Pagar boletos' }),
    ).not.toBe(base);
    expect(requestHash('POST', '/projects/p2/tasks', body)).not.toBe(base);
    expect(requestHash('PUT', path, body)).not.toBe(base);
  });
});

describe('IdempotencyStore.replay', () => {
  const store = new IdempotencyStore(
    {} as PrismaService,
    { get: () => 24 } as unknown as ConfigService<Env, true>,
  );
  const stored = { status: 201, body: { taskId: 't1' }, requestHash: 'h-1' };
  const request = { userId: 'u1', key: 'k-1', requestHash: 'h-1' };

  it('mesmo pedido: a mesma resposta (status e corpo)', () => {
    expect(store.replay(stored, request)).toEqual({
      status: 201,
      body: { taskId: 't1' },
    });
  });

  it('pedido diferente com a mesma chave: 422 IDEMPOTENCY_KEY_REUSED', () => {
    const replay = () =>
      store.replay(stored, { ...request, requestHash: 'outro' });
    expect(replay).toThrow(IdempotencyKeyReusedError);
    try {
      replay();
    } catch (error) {
      expect((error as IdempotencyKeyReusedError).getStatus()).toBe(422);
      expect((error as IdempotencyKeyReusedError).getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
    }
  });
});
