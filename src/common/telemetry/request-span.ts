import { context, type Span, trace } from '@opentelemetry/api';
import { getRPCMetadata, RPCType } from '@opentelemetry/core';

/**
 * O span HTTP do request (o `GET /projects`), e não o span ativo.
 *
 * Dentro de um middleware Express, o span ATIVO é o que o `instrumentation-express` cria para o próprio middleware
 * (`middleware - correlationIdMiddleware`). Um atributo gravado nele não aparece no span do request: foi o que
 * aconteceu com o `correlation.id` (Módulo 01) até o Módulo 14.1, que achou o problema ao gravar o cliente
 * (problema 1 do Módulo 14). A busca por tag no Jaeger encontrava o trace mesmo assim (procura em todos os spans),
 * mas o span do request, que é o que se lê e se filtra, ficava sem ele.
 *
 * O `instrumentation-http` guarda o span do request no contexto (`rpcMetadata`, o mesmo que o `RouteTelemetryGuard`
 * usa para a rota). Sem a instrumentação (testes), cai no span ativo.
 */
export function currentRequestSpan(): Span | undefined {
  const rpcMetadata = getRPCMetadata(context.active());
  return rpcMetadata?.type === RPCType.HTTP
    ? rpcMetadata.span
    : trace.getActiveSpan();
}
