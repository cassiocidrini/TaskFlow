/**
 * Observabilidade com OpenTelemetry: traces → Jaeger, métricas → Prometheus (Módulo 01).
 *
 * Este arquivo roda ANTES do NestJS (segundo import do `main.ts`). A auto-instrumentação aplica *patches* em
 * `http`, `express` e `pg` no momento em que essas bibliotecas são carregadas — se elas viessem antes, ficariam
 * de fora, sem nenhum erro visível.
 *
 * Padrão vendor-agnostic: trocar Jaeger por Datadog, Grafana Cloud ou X-Ray é trocar o exporter, sem mexer
 * no código instrumentado.
 */
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { registerTelemetryShutdown } from './common/lifecycle/telemetry-registry';
import { isHealthCheck } from './health/health-paths';
import { envSchema } from './config/env.schema';

// Ainda não existe ConfigService (o Nest não subiu). Reaproveitamos o MESMO schema zod para validar só este
// campo — mesma regra e mesmo default, sem duplicar a lógica. Endereço fixo no código quebraria em container,
// onde `localhost` não é o Jaeger (12-Factor: configuração no ambiente).
const otlpEndpoint = envSchema.shape.OTEL_EXPORTER_OTLP_ENDPOINT.parse(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
);

/** Traces: modelo PUSH — a aplicação envia cada span ao Jaeger via OTLP/HTTP. */
const traceExporter = new OTLPTraceExporter({
  url: `${otlpEndpoint}/v1/traces`,
});

/**
 * Métricas: modelo PULL — um servidor HTTP próprio do OTel em :9464/metrics, que o Prometheus coleta a cada 5 s.
 * É uma porta separada da API (3000): as métricas continuam acessíveis mesmo se a API estiver saturada.
 */
const metricExporter = new PrometheusExporter({
  port: 9464,
  host: '0.0.0.0',
});

/** Sem `service.name`, o Jaeger lista o serviço como `unknown_service:node`. */
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'taskflow',
});

const sdk = new NodeSDK({
  resource,
  traceExporter,
  metricReader: metricExporter,
  // Spans automáticos de HTTP, Express e PostgreSQL, sem alterar o código da aplicação.
  // Probes (/health/*) ficam fora: sem span e sem métrica HTTP, para não distorcer latência e req/s.
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': { ignoreIncomingRequestHook: (req) => isHealthCheck(req.url) },
    }),
  ],
});

sdk.start();
// console (e não o Logger do Nest): este código roda antes de o Nest existir
console.log('[OTel] Tracing e métricas inicializados (service: taskflow)');

// Encerramento: SEM handler de sinal próprio. Quem encerra o SDK é o ciclo de vida do Nest
// (`TelemetryShutdownHook`, último passo do graceful shutdown), depois de o HTTP fechar.
registerTelemetryShutdown(() => sdk.shutdown());
