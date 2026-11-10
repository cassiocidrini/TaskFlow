/*
 * Contexto de trace que atravessa uma fronteira assíncrona (Módulo 13): API → outbox → relay → Kafka → consumer.
 *
 * Dentro de um processo, o OTel carrega o span corrente no `AsyncLocalStorage`, e a auto-instrumentação o passa
 * adiante em HTTP. Uma linha parada na outbox não é uma chamada: nenhum instrumentador atravessa o banco. Por isso
 * o contexto vira DADO, no formato W3C Trace Context (`traceparent` + `tracestate`), gravado com a mensagem e
 * restaurado do outro lado.
 *
 * Usa o propagador GLOBAL (`propagation`), que o `NodeSDK` registra como W3C por padrão: trocar o formato (B3,
 * X-Ray) é configuração do SDK, não mudança aqui. Sem SDK registrado (testes unitários), o propagador é no-op e
 * as funções devolvem "sem contexto".
 */
import {
  context,
  propagation,
  ROOT_CONTEXT,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';

/** Carrier W3C: nomes de header → valor (`traceparent`, `tracestate`). */
export type TraceCarrier = Record<string, string>;

/**
 * O contexto de trace ATIVO como carrier, ou `null` fora de um span (scripts, seed): gravar `{}` diria "tem
 * contexto" quando não tem.
 */
export function captureTraceContext(): TraceCarrier | null {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return Object.keys(carrier).length > 0 ? carrier : null;
}

/**
 * O carrier que faz o próximo salto ser FILHO deste span (o relay põe o do span `create` nos headers do Kafka).
 */
export function carrierFor(span: Span): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(trace.setSpan(ROOT_CONTEXT, span), carrier);
  return carrier;
}

/**
 * Reconstrói o contexto a partir de um carrier lido de fora (coluna da outbox, headers do Kafka). Parte do
 * ROOT_CONTEXT, e não do contexto ativo: a mensagem pertence ao trace de quem a gravou, não ao do laço de polling.
 * Carrier ausente ou inválido = ROOT_CONTEXT (o span vira raiz de um trace novo, sem erro).
 */
export function contextFromCarrier(
  carrier: Readonly<Record<string, unknown>> | null | undefined,
): Context {
  if (!carrier) return ROOT_CONTEXT;
  const headers: TraceCarrier = {};
  for (const [name, value] of Object.entries(carrier)) {
    if (typeof value === 'string') headers[name] = value;
  }
  return propagation.extract(ROOT_CONTEXT, headers);
}
