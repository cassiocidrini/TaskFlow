/**
 * OpenTelemetry de verdade, mas com os spans em memória: o teste lê o que teria ido para o Jaeger.
 *
 * Registra as MESMAS três peças globais que o `NodeSDK` registra em produção (`start-telemetry.ts`): tracer
 * provider, propagador W3C e context manager com `AsyncLocalStorage`. Sem o context manager, `startActiveSpan` não
 * deixa o span ativo para o código chamado; sem o propagador, `inject`/`extract` são no-op. Faltando uma delas, o
 * teste passaria sem propagar nada.
 *
 * Global de verdade (é como a API do OTel funciona): use em `beforeAll` e chame `stop()` no `afterAll`.
 */
import { context, propagation, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';

export interface InMemoryTracing {
  /** Spans já ENCERRADOS, na ordem em que terminaram. */
  spans(): ReadableSpan[];
  /** Spans encerrados com este nome (ex.: `create taskflow.task-events.v1`). */
  named(name: string): ReadableSpan[];
  reset(): void;
  stop(): Promise<void>;
}

export function startInMemoryTracing(): InMemoryTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );

  return {
    spans: () => exporter.getFinishedSpans(),
    named: (name) => exporter.getFinishedSpans().filter((s) => s.name === name),
    reset: () => exporter.reset(),
    stop: async () => {
      await provider.shutdown();
      trace.disable();
      propagation.disable();
      context.disable();
    },
  };
}
