/**
 * Observabilidade com OpenTelemetry: traces → Jaeger, métricas → Prometheus (Módulo 01).
 *
 * Chamado ANTES do NestJS existir, pelo arquivo de bootstrap de cada processo (`src/tracing.ts` para a API,
 * `src/relay-tracing.ts` para o relay da outbox). A auto-instrumentação aplica *patches* em `http`, `express` e
 * `pg` no momento em que essas bibliotecas são carregadas — se elas viessem antes, ficariam de fora, sem nenhum
 * erro visível. Por isso este arquivo só importa OpenTelemetry, zod e módulos sem dependências.
 *
 * Uma função parametrizada, e não um arquivo por processo copiado: API e relay rodam no mesmo host em
 * desenvolvimento, então cada um precisa do SEU `service.name` (para o Jaeger separá-los) e da SUA porta de
 * métricas (duas instâncias na 9464 = o segundo processo não sobe o exporter).
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
import { registerTelemetryShutdown } from '../lifecycle/telemetry-registry';
import { isHealthCheck } from '../../health/health-paths';
import { envSchema } from '../../config/env.schema';

export interface TelemetryOptions {
  /** Nome do processo no Jaeger e no label `job`/`service_name` das métricas */
  serviceName: string;
  /** Porta do endpoint `/metrics` que o Prometheus coleta */
  metricsPort: number;
}

export function startTelemetry({
  serviceName,
  metricsPort,
}: TelemetryOptions): void {
  // Ainda não existe ConfigService (o Nest não subiu). Reaproveitamos o MESMO schema zod para validar só este
  // campo — mesma regra e mesmo default, sem duplicar a lógica. Endereço fixo no código quebraria em container,
  // onde `localhost` não é o Jaeger (12-Factor: configuração no ambiente).
  const otlpEndpoint = envSchema.shape.OTEL_EXPORTER_OTLP_ENDPOINT.parse(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  );

  /** Traces: modelo PUSH — o processo envia cada span ao Jaeger via OTLP/HTTP. */
  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  });

  /**
   * Métricas: modelo PULL — um servidor HTTP próprio do OTel em `:<metricsPort>/metrics`, que o Prometheus coleta
   * a cada 5 s. Porta separada da API (3000): as métricas continuam acessíveis mesmo se a API estiver saturada.
   */
  const metricExporter = new PrometheusExporter({
    port: metricsPort,
    host: '0.0.0.0',
  });

  const sdk = new NodeSDK({
    // Sem `service.name`, o Jaeger lista o serviço como `unknown_service:node`
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    traceExporter,
    metricReader: metricExporter,
    // Spans automáticos de HTTP, Express e PostgreSQL, sem alterar o código da aplicação.
    // Probes (/health/*) ficam fora: sem span e sem métrica HTTP, para não distorcer latência e req/s.
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => isHealthCheck(req.url),
        },
        // Query sem span pai não vira trace solto: o polling do relay (uma transação a cada 500 ms, mesmo com a
        // outbox vazia) geraria ~7 mil traces por hora sem informação. Na API, toda query de negócio já nasce
        // dentro do span HTTP; só as do boot deixam de aparecer.
        '@opentelemetry/instrumentation-pg': { requireParentSpan: true },
      }),
    ],
  });

  sdk.start();
  // console (e não o Logger do Nest): este código roda antes de o Nest existir
  console.log(
    `[OTel] Tracing e métricas inicializados (service: ${serviceName}, métricas em :${metricsPort})`,
  );

  // Encerramento: SEM handler de sinal próprio. Quem encerra o SDK é o ciclo de vida do Nest
  // (`TelemetryShutdownHook`, último passo do graceful shutdown), depois de o processo parar de trabalhar.
  registerTelemetryShutdown(() => sdk.shutdown());
}
