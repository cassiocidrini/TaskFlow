/**
 * Registro da função que encerra o OpenTelemetry. Arquivo SEM nenhum import, de propósito.
 *
 * O `tracing.ts` precisa registrar o shutdown do SDK, mas roda ANTES de qualquer biblioteca ser carregada: o OTel
 * só instrumenta `http`/`express`/`pg` se os aplicar antes de eles serem importados. Se este registro morasse junto
 * do hook do Nest (`telemetry-shutdown.ts`), o import do `tracing.ts` puxaria o `@nestjs/common` antes do
 * `sdk.start()`. Separar mantém a ordem crítica do `main.ts`.
 */
let shutdownTelemetry: (() => Promise<void>) | undefined;

/** Chamado uma vez pelo `tracing.ts`, logo após `sdk.start()`. */
export function registerTelemetryShutdown(fn: () => Promise<void>): void {
  shutdownTelemetry = fn;
}

/** A função registrada, ou `undefined` quando o tracing não foi carregado (testes E2E). */
export function registeredTelemetryShutdown(): (() => Promise<void>) | undefined {
  return shutdownTelemetry;
}
