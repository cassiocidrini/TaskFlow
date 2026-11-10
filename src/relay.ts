// ORDEM CRÍTICA dos dois primeiros imports (a mesma do `main.ts`): `.env` antes de tudo; telemetria antes de o
// Nest e o `pg` serem carregados, senão a auto-instrumentação não os alcança.
import './env';
import './relay-tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import { armShutdownWatchdog } from './common/lifecycle/shutdown-watchdog';
import type { RelayEnv } from './config/relay-env.schema';
import { RelayModule } from './outbox-relay/relay.module';

/**
 * Processo do relay da outbox (Módulo 13.3): `npm run relay:dev` em desenvolvimento, `node dist/relay` no build.
 *
 * Separado da API de propósito: escala, cai e é implantado sozinho. Um `setInterval` dentro da API rodaria um relay
 * por réplica da API e escalaria com o tráfego HTTP, que não tem relação com o volume de eventos. Mesma imagem,
 * outro comando.
 *
 * `createApplicationContext`: Nest sem servidor HTTP — injeção de dependência, config, logs e ciclo de vida, sem
 * abrir porta (além da de métricas do OpenTelemetry, 9465).
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(RelayModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('RelayBootstrap');

  // SIGTERM/SIGINT → app.close(): termina o lote em andamento, desconecta o produtor, fecha Prisma e OTel
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  armShutdownWatchdog(
    app
      .get<ConfigService<RelayEnv, true>>(ConfigService)
      .get('SHUTDOWN_TIMEOUT_MS', { infer: true }),
    logger,
  );

  // Sem `listen`: o loop do relay começa no `onApplicationBootstrap` e mantém o processo vivo
  await app.init();
  logger.log('Relay da outbox no ar');
}

// Falha no boot (config inválida, banco inacessível) = saída com código ≠ 0: o orquestrador reinicia
bootstrap().catch((err: unknown) => {
  new Logger('RelayBootstrap').error(
    'Erro fatal na inicialização do relay',
    err instanceof Error ? err.stack : err,
  );
  process.exit(1);
});
