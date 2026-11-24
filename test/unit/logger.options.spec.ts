/**
 * Opções do logger (`nestjs-pino`).
 *
 * Protege: o log de acesso nunca serializa headers (o `Authorization` não vaza, OWASP A09); o id da requisição é o
 * mesmo `correlationId` do contexto (log de acesso e logs da aplicação ficam ligados); o nível do log de acesso
 * separa falha nossa (5xx → error) de erro do cliente (4xx → warn); o pino-pretty só entra quando pedido; e o cliente
 * (plataforma e versão, Módulo 14.1) entra na linha de acesso já VALIDADO pelo middleware, nunca o header cru, e
 * UMA vez só.
 *
 * O teste do cliente roda o pino-http REAL num servidor HTTP em memória e confere a linha CRUA: o `client` saiu
 * duplicado por meses (o pino-http chama o `customProps` duas vezes), e nenhum teste viu, porque o teste antigo
 * conferia só a função (que estava certa) e o `JSON.parse` aceita chave duplicada em silêncio, ficando com a última.
 */
import { createServer, type Server } from 'node:http';
import pino from 'pino';
import pinoHttp from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Options } from 'pino-http';
import { runWithCorrelationId } from '../../src/common/correlation/correlation-context';
import { accessLogLevel, buildLoggerOptions } from '../../src/common/logging/logger.options';
import { isHealthCheck } from '../../src/health/health-paths';

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

describe('o cliente na linha de acesso (pino-http real, linha crua)', () => {
  let server: Server;
  let baseUrl: string;
  const lines: string[] = [];

  beforeAll(async () => {
    const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(line) });
    const middleware = pinoHttp({ ...pinoHttpOptions(), logger });
    server = createServer((req, res) => {
      // Faz o papel do clientInfoMiddleware: só o cliente VALIDADO vai para `appClient`
      if (req.headers['x-test-validated'] === 'yes') {
        (req as IncomingMessage & { appClient: unknown }).appClient = {
          platform: 'android',
          appVersion: { major: 2, minor: 13, patch: 1 },
        };
      }
      middleware(req, res, () => {
        res.statusCode = Number(new URL(req.url!, 'http://x').searchParams.get('status'));
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  async function accessLine(status: number, headers: Record<string, string>): Promise<string> {
    const before = lines.length;
    await fetch(`${baseUrl}/tarefas?status=${status}`, { headers });
    // A linha de acesso é escrita no 'finish' da resposta, que pode vir logo depois de o cliente receber o corpo
    for (let i = 0; i < 50 && lines.length === before; i++) await new Promise((r) => setTimeout(r, 10));
    expect(lines.length).toBe(before + 1);
    return lines[lines.length - 1];
  }

  it.each([
    [201, 30],
    [426, 40],
    [500, 50],
  ])('status %i: o cliente validado aparece UMA vez na linha crua (nível %i)', async (status, level) => {
    const raw = await accessLine(status, { 'x-test-validated': 'yes' });

    expect(raw.match(/"client"/g)).toHaveLength(1);
    expect(JSON.parse(raw)).toMatchObject({
      level,
      client: { platform: 'android', appVersion: '2.13.1' },
      res: { statusCode: status },
    });
  });

  it('sem cliente validado não há client, e o header cru (mesmo forjado) nunca entra na linha', async () => {
    const raw = await accessLine(200, { 'x-app-version': '2.14.0 linha-forjada', 'x-platform': 'ios' });

    expect(raw).not.toContain('"client"');
    expect(raw).not.toContain('linha-forjada');
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
