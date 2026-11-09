/**
 * `RouteTelemetryGuard` — o `http.route` da telemetria.
 *
 * Protege: o guard NUNCA bloqueia (não é controle de acesso); grava o PADRÃO da rota, e não a URL com ids (cada UUID
 * seria uma série nova no Prometheus); sem rota casada (404) não inventa valor; e sem o SDK do OpenTelemetry
 * (testes, scripts) não faz nada. A ordem entre os guards globais (este antes do throttler e do JWT) foi verificada
 * na métrica real: um 401 sai com `http_route` (ver Módulo 01).
 */
import type { ExecutionContext } from '@nestjs/common';
import { ROOT_CONTEXT, context, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { RPCType, getRPCMetadata, setRPCMetadata, type RPCMetadata } from '@opentelemetry/core';
import { RouteTelemetryGuard } from '../../src/common/telemetry/route-telemetry.guard';

const httpContext = (request: object) =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe('RouteTelemetryGuard', () => {
  const guard = new RouteTelemetryGuard();
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    // Sem um context manager registrado, context.with() não propaga nada (é o que acontece sem o SDK)
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    context.disable();
  });

  /** Executa o guard dentro de um contexto com o rpcMetadata HTTP que o instrumentation-http cria. */
  const runInHttpContext = (request: object) => {
    const rpcMetadata: RPCMetadata = { type: RPCType.HTTP, span: {} as Span };
    const allowed = context.with(setRPCMetadata(ROOT_CONTEXT, rpcMetadata), () =>
      guard.canActivate(httpContext(request)),
    );
    return { allowed, rpcMetadata };
  };

  it('deve gravar o PADRÃO da rota, e não a URL com ids', () => {
    const { allowed, rpcMetadata } = runInHttpContext({
      url: '/projects/3f2a9c1e-0000-4000-8000-000000000000/tasks',
      route: { path: '/projects/:projectId/tasks' },
    });

    expect(allowed).toBe(true);
    expect(rpcMetadata.route).toBe('/projects/:projectId/tasks');
  });

  it('não deve inventar rota quando nenhuma foi casada', () => {
    const { allowed, rpcMetadata } = runInHttpContext({ url: '/nao-existe' });

    expect(allowed).toBe(true);
    expect(rpcMetadata.route).toBeUndefined();
  });

  it('não deve fazer nada (nem falhar) sem o SDK do OpenTelemetry', () => {
    expect(getRPCMetadata(context.active())).toBeUndefined();
    expect(guard.canActivate(httpContext({ route: { path: '/' } }))).toBe(true);
  });
});
