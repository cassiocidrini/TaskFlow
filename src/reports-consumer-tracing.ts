/**
 * Telemetria do consumer de relatórios — SEGUNDO import do `reports-consumer.ts`, antes de qualquer import do Nest.
 * Serviço próprio no Jaeger (`taskflow-reports`) e porta de métricas própria (9468 por padrão).
 */
import { startTelemetry } from './common/telemetry/start-telemetry';
import { consumerEnvSchema } from './config/consumer-env.schema';

startTelemetry({
  serviceName: 'taskflow-reports',
  metricsPort: consumerEnvSchema.shape.REPORTS_METRICS_PORT.parse(
    process.env.REPORTS_METRICS_PORT,
  ),
});
