/**
 * Telemetria do consumer de notificações — SEGUNDO import do `notifications-consumer.ts`, antes de qualquer import
 * do Nest. Serviço próprio no Jaeger (`taskflow-notifications`) e porta de métricas própria (9467 por padrão).
 */
import { startTelemetry } from './common/telemetry/start-telemetry';
import { consumerEnvSchema } from './config/consumer-env.schema';

startTelemetry({
  serviceName: 'taskflow-notifications',
  metricsPort: consumerEnvSchema.shape.NOTIFICATIONS_METRICS_PORT.parse(
    process.env.NOTIFICATIONS_METRICS_PORT,
  ),
});
