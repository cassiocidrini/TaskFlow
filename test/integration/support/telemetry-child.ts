/**
 * Processo filho do `telemetry-export.spec.ts`: roda o `startTelemetry` REAL, como a API e o relay, e emite um span e
 * uma métrica de sonda.
 *
 * Num processo próprio porque o `startTelemetry` registra providers GLOBAIS e aplica patches da auto-instrumentação
 * em `http`, `pg` e companhia: dentro do Jest, contaminaria as outras suítes e seria contaminado por elas.
 *
 * Recebe a porta de métricas pela env `TELEMETRY_TEST_METRICS_PORT`; o destino dos traces é o
 * `OTEL_EXPORTER_OTLP_ENDPOINT` normal (no teste, um servidor HTTP falso no lugar do Jaeger).
 */
import { metrics, trace } from '@opentelemetry/api';
import { startTelemetry } from '../../../src/common/telemetry/start-telemetry';

startTelemetry({
  serviceName: 'telemetry-export-test',
  metricsPort: Number(process.env.TELEMETRY_TEST_METRICS_PORT),
});

metrics.getMeter('telemetry-export-test').createCounter('telemetry_export_probe').add(1);
trace.getTracer('telemetry-export-test').startSpan('telemetry-export-probe').end();

// Avisa o teste e fica vivo até ser encerrado (o servidor do /metrics precisa continuar no ar)
process.stdout.write('telemetry-child-ready\n');
setInterval(() => undefined, 60_000);
