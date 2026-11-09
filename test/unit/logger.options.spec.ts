/**
 * Opções do logger (`nestjs-pino`).
 *
 * Protege: o log de acesso nunca serializa headers (o `Authorization` não vaza, OWASP A09); o id da requisição é o
 * mesmo `correlationId` do contexto (log de acesso e logs da aplicação ficam ligados); o nível do log de acesso
 * separa falha nossa (5xx → error) de erro do cliente (4xx → warn); e o pino-pretty só entra quando pedido.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { runWithCorrelationId } from '../../src/common/correlation/correlation-context';
import { accessLogLevel, buildLoggerOptions, isHealthCheck } from '../../src/common/logging/logger.options';

function pinoHttpOptions(LOG_PRETTY = false): Options {
  return buildLoggerOptions({ LOG_LEVEL: 'info', LOG_PRETTY }).pinoHttp as Options;
}

describe('buildLoggerOptions', () => {
  it('deve serializar a requisição só com método e url, sem headers', () => {
    const serialized = pinoHttpOptions().serializers!.req({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer segredo', cookie: 'sessao=1' },
    });

    expect(serialized).toEqual({ method: 'GET', url: '/auth/me' });
  });

  it('deve serializar a resposta só com o status', () => {
    const serialized = pinoHttpOptions().serializers!.res({ statusCode: 201, headers: { 'set-cookie': 'x' } });

    expect(serialized).toEqual({ statusCode: 201 });
  });

  it('deve usar o correlationId do contexto como id da requisição', () => {
    const genReqId = pinoHttpOptions().genReqId!;

    const id = runWithCorrelationId('chamado-1234', () =>
      genReqId({} as IncomingMessage, {} as ServerResponse),
    );

    expect(id).toBe('chamado-1234');
  });

  it('deve gravar o id com o nome correlationId (e não reqId)', () => {
    expect(pinoHttpOptions().customAttributeKeys).toEqual({ reqId: 'correlationId' });
  });

  it('deve emitir JSON por padrão e só usar o pino-pretty quando LOG_PRETTY=true', () => {
    expect(pinoHttpOptions(false).transport).toBeUndefined();
    expect(pinoHttpOptions(true).transport).toMatchObject({ target: 'pino-pretty' });
  });
});

// Probes a cada poucos segundos não podem inundar o log de acesso
describe('isHealthCheck', () => {
  it.each(['/health/live', '/health/ready', '/health/ready?x=1', '/health'])('deve ignorar %s', (url) => {
    expect(isHealthCheck(url)).toBe(true);
  });

  it.each(['/', '/healthy', '/projects/health', '/auth/me', undefined])('NÃO deve ignorar %s', (url) => {
    expect(isHealthCheck(url)).toBe(false);
  });
});

describe('accessLogLevel', () => {
  const res = (statusCode: number) => ({ statusCode }) as ServerResponse;

  it.each([
    [200, 'info'],
    [201, 'info'],
    [304, 'info'],
    [400, 'warn'],
    [404, 'warn'],
    [429, 'warn'],
    [500, 'error'],
    [503, 'error'],
  ])('status %i → %s', (status, level) => {
    expect(accessLogLevel(res(status))).toBe(level);
  });

  it('deve ser error quando a requisição terminou com exceção, mesmo com status < 500', () => {
    expect(accessLogLevel(res(200), new Error('socket fechado'))).toBe('error');
  });
});
