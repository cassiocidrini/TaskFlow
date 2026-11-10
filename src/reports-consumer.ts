// ORDEM CRÍTICA dos dois primeiros imports (a mesma do `main.ts`, do `relay.ts` e do `notifications-consumer.ts`)
import './env';
import './reports-consumer-tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import { armShutdownWatchdog } from './common/lifecycle/shutdown-watchdog';
import type { ConsumerEnv } from './config/consumer-env.schema';
import { ReportsConsumerModule } from './modules/reports/consumer/reports-consumer.module';

/**
 * Processo do consumer group `reports` (Módulo 13.6a): `npm run consumer:reports:dev` em desenvolvimento,
 * `node dist/reports-consumer` no build.
 *
 * Um processo por consumer group, e não os dois grupos num processo só: cada um escala, falha e é implantado
 * independente do outro. Uma partição do `reports` travada esperando o banco não atrasa as notificações.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    ReportsConsumerModule,
    {
      bufferLogs: true,
    },
  );
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('ReportsConsumerBootstrap');

  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  armShutdownWatchdog(
    app
      .get<ConfigService<ConsumerEnv, true>>(ConfigService)
      .get('SHUTDOWN_TIMEOUT_MS', { infer: true }),
    logger,
  );

  await app.init();
  logger.log('Consumer de relatórios no ar');
}

bootstrap().catch((err: unknown) => {
  new Logger('ReportsConsumerBootstrap').error(
    'Erro fatal na inicialização do consumer de relatórios',
    err instanceof Error ? err.stack : err,
  );
  process.exit(1);
});
