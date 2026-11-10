/**
 * Telemetria do relay da outbox — SEGUNDO import do `relay.ts`, antes de qualquer import do Nest.
 *
 * Outro `service.name` (o Jaeger separa os spans do relay dos da API) e outra porta de métricas (9465 por padrão):
 * os dois processos rodam lado a lado no mesmo host em desenvolvimento. A porta é lida aqui com o MESMO schema zod
 * do relay, porque o `ConfigService` ainda não existe.
 */
import { startTelemetry } from './common/telemetry/start-telemetry';
import { relayEnvSchema } from './config/relay-env.schema';

startTelemetry({
  serviceName: 'taskflow-relay',
  metricsPort: relayEnvSchema.shape.RELAY_METRICS_PORT.parse(
    process.env.RELAY_METRICS_PORT,
  ),
});
