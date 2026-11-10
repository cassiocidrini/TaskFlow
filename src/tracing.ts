/**
 * Telemetria da API — SEGUNDO import do `main.ts`, antes de qualquer import do Nest (ver `startTelemetry`).
 *
 * Arquivo de efeito colateral: importá-lo já inicia o SDK. Separado do `main.ts` porque `import` é içado
 * (*hoisted*): uma chamada no corpo do `main.ts` rodaria DEPOIS de o Nest e o `pg` já terem sido carregados.
 */
import { startTelemetry } from './common/telemetry/start-telemetry';

startTelemetry({ serviceName: 'taskflow', metricsPort: 9464 });
