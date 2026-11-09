/**
 * Middleware de `X-Correlation-Id` e contexto de correlação (`AsyncLocalStorage`).
 *
 * Protege: o id do cliente é mantido quando válido; ausente, repetido ou inválido (log injection, tamanho) vira um
 * UUID novo SEM derrubar a requisição; o id volta no header da resposta; e o código chamado depois do middleware
 * (inclusive após `await`) lê o MESMO id, sem vazar entre requisições simultâneas.
 *
 * O atributo `correlation.id` no span não é testado aqui: sem o SDK do OTel não há span ativo. Ele foi verificado
 * manualmente no Jaeger (ver docs/modules/01-observabilidade.md).
 */
import type { NextFunction, Request, Response } from 'express';
import {
  currentCorrelationId,
  runWithCorrelationId,
} from '../../src/common/correlation/correlation-context';
import {
  CORRELATION_ID_HEADER,
  correlationIdMiddleware,
  resolveCorrelationId,
} from '../../src/common/correlation/correlation-id.middleware';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('resolveCorrelationId', () => {
  it.each(['chamado-1234', '0b7f3a52-6a51-4a5e-9a1f-2f6f3c1d2e4b', '01JC3ZQK7Y.trace_x', 'a'.repeat(64)])(
    'deve manter um id válido: "%s"',
    (incoming) => {
      expect(resolveCorrelationId(incoming)).toBe(incoming);
    },
  );

  it.each([
    ['ausente', undefined],
    ['vazio', ''],
    ['com quebra de linha (log injection)', 'abc\n{"level":60}'],
    ['com espaço e HTML', 'a b<script>'],
    ['maior que 64 caracteres', 'a'.repeat(65)],
    ['header repetido (array)', ['um', 'dois']],
  ])('deve gerar um UUID novo quando o id é %s', (_caso, incoming) => {
    expect(resolveCorrelationId(incoming)).toMatch(UUID_V4);
  });
});

describe('correlationIdMiddleware', () => {
  function invoke(headers: Record<string, string>, next: NextFunction) {
    const req = { headers } as unknown as Request;
    const setHeader = jest.fn();
    correlationIdMiddleware(req, { setHeader } as unknown as Response, next);
    return setHeader;
  }

  it('deve devolver o id recebido no header da resposta e expô-lo ao código seguinte', () => {
    let seen: string | undefined;

    const setHeader = invoke({ 'x-correlation-id': 'chamado-1234' }, () => {
      seen = currentCorrelationId();
    });

    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'chamado-1234');
    expect(seen).toBe('chamado-1234');
  });

  it('deve gerar um id quando o header falta, e o id da resposta deve ser o mesmo do contexto', () => {
    let seen: string | undefined;

    const setHeader = invoke({}, () => {
      seen = currentCorrelationId();
    });

    expect(seen).toMatch(UUID_V4);
    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, seen);
  });
});

describe('contexto de correlação', () => {
  it('não deve existir fora de um runWithCorrelationId (ex.: boot da aplicação)', () => {
    expect(currentCorrelationId()).toBeUndefined();
  });

  it('deve sobreviver a await e não vazar entre execuções simultâneas', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const handle = (id: string) =>
      runWithCorrelationId(id, async () => {
        await tick();
        await tick();
        return currentCorrelationId();
      });

    // Intercaladas no event loop: sem o ALS, uma variável global veria o id da outra
    const [a, b] = await Promise.all([handle('req-a'), handle('req-b')]);

    expect([a, b]).toEqual(['req-a', 'req-b']);
  });
});
