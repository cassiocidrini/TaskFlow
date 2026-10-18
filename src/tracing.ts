import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { envSchema } from './config/env.schema';

// O tracing sobe ANTES do Nest (precisa instrumentar http/express/pg primeiro),
// então ainda não existe ConfigService. Reaproveitamos o MESMO schema para validar
// só este campo — mesma regra e mesmo default, sem duplicar a lógica.
const otlpEndpoint = envSchema.shape.OTEL_EXPORTER_OTLP_ENDPOINT.parse(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
);

const traceExporter = new OTLPTraceExporter({
  url: `${otlpEndpoint}/v1/traces`,
});

const metricExporter = new PrometheusExporter({
  port: 9464,
  host: '0.0.0.0',
});

// 🔑 AQUI: define o nome do serviço
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'taskflow',
});

const sdk = new NodeSDK({
  resource,             // ← passa o resource
  traceExporter,
  metricReader: metricExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
console.log('[OTel] Tracing e métricas inicializados (service: taskflow)');

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .then(() => console.log('[OTel] Encerrado'))
    .catch((err) => console.error('[OTel] Erro ao encerrar', err))
    .finally(() => process.exit(0));
});