/**
 * Middleware de identificação do cliente e o `@AppClient()` (Módulo 14.1), com OpenTelemetry DE VERDADE em memória.
 *
 * Protege o que cada destino recebe:
 * - o request ganha o `ClientInfo` (o que o decorator e o log de acesso leem), e o `next` é sempre chamado: nenhum
 *   header derruba a requisição;
 * - o span do REQUEST (e não o do middleware, que é o ativo dentro do Express) ganha a plataforma e a versão
 *   COMPLETA; o `correlation.id` vai para o mesmo lugar (o bug do Módulo 01 que esta etapa achou);
 * - a métrica conta por plataforma e `MAJOR.MINOR`, e NÃO conta os probes de health;
 * - o contador é criado na fábrica: com o provider registrado depois do import do arquivo, ele ainda exporta (a API
 *   de métricas não tem provider "proxy").
 */
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import type { ExecutionContext } from '@nestjs/common';
import { context, metrics, trace } from '@opentelemetry/api';
import { RPCType, setRPCMetadata } from '@opentelemetry/core';
import {
  AggregationTemporality,
  MeterProvider,
  MetricReader,
} from '@opentelemetry/sdk-metrics';
import type { NextFunction, Request, Response } from 'express';
import { AppClient } from '../../src/common/client/app-client.decorator';
import { UNKNOWN_CLIENT } from '../../src/common/client/client-info';
import {
  CLIENT_APP_VERSION_SPAN_ATTRIBUTE,
  CLIENT_PLATFORM_SPAN_ATTRIBUTE,
  createClientInfoMiddleware,
  type RequestWithClient,
} from '../../src/common/client/client-info.middleware';
import {
  CORRELATION_ID_SPAN_ATTRIBUTE,
  correlationIdMiddleware,
} from '../../src/common/correlation/correlation-id.middleware';
import {
  startInMemoryTracing,
  type InMemoryTracing,
} from '../support/in-memory-tracing';

/** Leitor de métricas sob demanda: `collect()` devolve o que foi contado até agora. */
class TestMetricReader extends MetricReader {
  constructor() {
    super({
      aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
    });
  }
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const requestWith = (url: string, headers: Record<string, string>) =>
  ({ url, headers }) as unknown as Request & RequestWithClient;

describe('clientInfoMiddleware', () => {
  let tracing: InMemoryTracing;
  let reader: TestMetricReader;
  let provider: MeterProvider;

  beforeEach(() => {
    tracing = startInMemoryTracing();
    reader = new TestMetricReader();
    provider = new MeterProvider({ readers: [reader] });
    metrics.setGlobalMeterProvider(provider);
  });

  afterEach(async () => {
    await tracing.stop();
    await provider.shutdown();
    metrics.disable();
  });

  /** Pontos da métrica como `[atributos, valor]`. */
  const counted = async () => {
    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === 'taskflow_app_requests');
    return (metric?.dataPoints ?? []).map((p) => [p.attributes, p.value]);
  };

  it('anexa o cliente ao request, grava no span e conta na métrica', async () => {
    const middleware = createClientInfoMiddleware();
    const req = requestWith('/projects', {
      'x-platform': 'ios',
      'x-app-version': '2.14.7',
    });
    const next = jest.fn();

    trace.getTracer('test').startActiveSpan('GET /projects', (span) => {
      middleware(req, {} as Response, next as NextFunction);
      span.end();
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.appClient).toEqual({
      platform: 'ios',
      appVersion: { major: 2, minor: 14, patch: 7 },
    });
    const [span] = tracing.named('GET /projects');
    expect(span.attributes[CLIENT_PLATFORM_SPAN_ATTRIBUTE]).toBe('ios');
    expect(span.attributes[CLIENT_APP_VERSION_SPAN_ATTRIBUTE]).toBe('2.14.7'); // completa no span
    expect(await counted()).toEqual([
      [{ platform: 'ios', app_version: '2.14' }, 1], // truncada na métrica
    ]);
  });

  it('como no Express: com o span do middleware ativo, os atributos vão para o span do REQUEST', () => {
    const middleware = createClientInfoMiddleware();
    const tracer = trace.getTracer('test');
    const req = requestWith('/projects', {
      'x-platform': 'android',
      'x-app-version': '2.13.1',
      'x-correlation-id': 'chamado-42',
    });

    // O instrumentation-http guarda o span do request no contexto; o instrumentation-express abre um span por
    // middleware, que passa a ser o ATIVO enquanto ele roda
    tracer.startActiveSpan('GET /projects', (server) => {
      const withRequest = setRPCMetadata(context.active(), {
        type: RPCType.HTTP,
        span: server,
      });
      context.with(withRequest, () => {
        tracer.startActiveSpan('middleware - clientInfoMiddleware', (mw) => {
          middleware(req, {} as Response, jest.fn() as NextFunction);
          correlationIdMiddleware(
            req,
            { setHeader: jest.fn() } as unknown as Response,
            jest.fn(),
          );
          mw.end();
        });
      });
      server.end();
    });

    const [server] = tracing.named('GET /projects');
    const [mw] = tracing.named('middleware - clientInfoMiddleware');
    expect(server.attributes[CLIENT_PLATFORM_SPAN_ATTRIBUTE]).toBe('android');
    expect(server.attributes[CLIENT_APP_VERSION_SPAN_ATTRIBUTE]).toBe('2.13.1');
    expect(server.attributes[CORRELATION_ID_SPAN_ATTRIBUTE]).toBe('chamado-42');
    expect(mw.attributes).toEqual({});
  });

  it('headers inválidos: segue (next) como desconhecido, sem versão no span', async () => {
    const middleware = createClientInfoMiddleware();
    const req = requestWith('/', {
      'x-platform': 'symbian',
      'x-app-version': 'latest',
    });
    const next = jest.fn();

    trace.getTracer('test').startActiveSpan('GET /', (span) => {
      middleware(req, {} as Response, next as NextFunction);
      span.end();
    });

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.appClient).toEqual(UNKNOWN_CLIENT);
    const [span] = tracing.named('GET /');
    expect(span.attributes[CLIENT_APP_VERSION_SPAN_ATTRIBUTE]).toBeUndefined();
    expect(await counted()).toEqual([
      [{ platform: 'unknown', app_version: 'none' }, 1],
    ]);
  });

  it('probes de health não contam na métrica (mas o request ainda recebe o cliente)', async () => {
    const middleware = createClientInfoMiddleware();
    const req = requestWith('/health/ready', {});

    middleware(req, {} as Response, jest.fn() as NextFunction);

    expect(req.appClient).toEqual(UNKNOWN_CLIENT);
    expect(await counted()).toEqual([]);
  });
});

describe('@AppClient()', () => {
  /** A função que o Nest executa para o parâmetro decorado, extraída dos metadados da rota. */
  const factoryOf = () => {
    class Controller {
      handler(@AppClient() _client: unknown) {}
    }
    const args = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      Controller,
      'handler',
    ) as Record<
      string,
      { factory: (data: unknown, ctx: ExecutionContext) => unknown }
    >;
    return Object.values(args)[0].factory;
  };
  const contextFor = (req: object) =>
    ({ switchToHttp: () => ({ getRequest: () => req }) }) as ExecutionContext;

  it('devolve o cliente que o middleware anexou', () => {
    const client = { platform: 'android', appVersion: null };
    expect(factoryOf()(undefined, contextFor({ appClient: client }))).toBe(
      client,
    );
  });

  it('sem o middleware, devolve o desconhecido em vez de undefined', () => {
    expect(factoryOf()(undefined, contextFor({}))).toBe(UNKNOWN_CLIENT);
  });
});
