import type { Logger } from '@nestjs/common';

/**
 * Watchdog do encerramento: se algum hook travar (conexão presa, requisição sem fim, lote preso no Kafka), força
 * a saída com código 1 depois de `timeoutMs`. Melhor o processo sair sozinho, registrando o motivo, do que levar
 * SIGKILL do orquestrador em silêncio. O timer é `unref()`: num encerramento normal ele não segura o processo vivo.
 *
 * Compartilhado pelos dois entrypoints (`main.ts` da API e `relay.ts` do relay da outbox).
 */
export function armShutdownWatchdog(timeoutMs: number, logger: Logger): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      setTimeout(() => {
        logger.error(
          `Encerramento excedeu ${timeoutMs} ms após ${signal}: saída forçada`,
        );
        process.exit(1);
      }, timeoutMs).unref();
    });
  }
}
