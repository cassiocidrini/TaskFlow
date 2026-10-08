import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const traceExporter = new OTLPTraceExporter({
  url: 'http://localhost:4318/v1/traces',
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