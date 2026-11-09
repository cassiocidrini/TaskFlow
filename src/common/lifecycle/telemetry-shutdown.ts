import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { registeredTelemetryShutdown } from './telemetry-registry';

/**
 * Encerra o OpenTelemetry (iniciado ANTES do Nest, em `tracing.ts`) pelo ciclo de vida do Nest.
 *
 * Roda no ÚLTIMO passo do `app.close()`: depois de o HTTP fechar e de o Prisma desconectar, então os spans das
 * últimas requisições também são enviados. Antes, o `tracing.ts` tinha o próprio `process.on('SIGTERM')` com
 * `process.exit(0)`, que encerrava o processo sem esperar o Nest e cortava requisições em andamento.
 *
 * Nos testes E2E o `tracing.ts` não é carregado: nada é registrado e o hook não faz nada. O `AppModule` é o mesmo
 * em produção e no teste.
 */
@Injectable()
export class TelemetryShutdownHook implements OnApplicationShutdown {
  private readonly logger = new Logger('Telemetry');

  async onApplicationShutdown(): Promise<void> {
    const shutdown = registeredTelemetryShutdown();
    if (!shutdown) {
      return;
    }
    try {
      await shutdown();
      this.logger.log('OpenTelemetry encerrado (spans e métricas pendentes enviados)');
    } catch (error) {
      // Falhar ao enviar telemetria não deve impedir o processo de terminar
      this.logger.error('Erro ao encerrar o OpenTelemetry', error instanceof Error ? error.stack : error);
    }
  }
}
