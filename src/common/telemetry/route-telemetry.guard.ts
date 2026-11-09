import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { context } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';

/** O que o guard lê da requisição Express: o padrão da rota que o roteador casou. */
interface RoutedRequest {
  route?: { path?: unknown };
}

/**
 * Preenche `http.route` no span HTTP e na métrica `http_server_request_duration`. NÃO é controle de acesso:
 * sempre devolve `true`.
 *
 * O problema: com Express 5 + Nest, o `instrumentation-express` deixa vazia a rota do `rpcMetadata` do OTel. Sem
 * ela, o `instrumentation-http` grava a métrica sem `http_route` e o span raiz se chama só `GET`. Não dá para
 * saber qual endpoint está lento ou falhando.
 *
 * Por que um guard, e o PRIMEIRO `APP_GUARD`: é o ponto mais cedo do Nest em que a rota já foi resolvida.
 * Middleware roda antes do roteamento (não sabe a rota). Interceptor roda DEPOIS dos guards: uma requisição barrada
 * pelo JWT (401) ou pelo throttler (429) sairia sem rota, e são justamente os erros que mais interessa ver por
 * endpoint (verificado num experimento antes de escolher o guard).
 *
 * Grava o PADRÃO (`/projects/:projectId/tasks`), nunca a URL (`/projects/3f2a…/tasks`): cada UUID viraria uma série
 * nova no Prometheus (explosão de cardinalidade). Rota inexistente (404) fica sem `http_route`, como pede a
 * semântica do OpenTelemetry. Sem o SDK (testes), não há `rpcMetadata` e o guard não faz nada.
 */
@Injectable()
export class RouteTelemetryGuard implements CanActivate {
  canActivate(executionContext: ExecutionContext): boolean {
    const route = executionContext.switchToHttp().getRequest<RoutedRequest>().route?.path;
    const rpcMetadata = getRPCMetadata(context.active());

    if (rpcMetadata?.type === RPCType.HTTP && typeof route === 'string') {
      rpcMetadata.route = route;
    }
    return true;
  }
}
