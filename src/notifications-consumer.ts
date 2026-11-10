// ORDEM CRÍTICA dos dois primeiros imports (a mesma do `main.ts` e do `relay.ts`)
import './env';
import './notifications-consumer-tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger as PinoLogger } from 'nestjs-pino';
import { armShutdownWatchdog } from './common/lifecycle/shutdown-watchdog';
import type { ConsumerEnv } from './config/consumer-env.schema';
import { NotificationsConsumerModule } from './modules/notifications/consumer/notifications-consumer.module';

/**
 * Processo do consumer group `notifications` (Módulo 13.4): `npm run consumer:notifications:dev` em
 * desenvolvimento, `node dist/notifications-consumer` no build.
 *
 * Separado da API e do relay: cada consumer group escala pelo número de partições do tópico, não pelo tráfego HTTP,
 * e uma falha aqui (ex.: mensagem que trava uma partição) não afeta quem grava os eventos.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(
    NotificationsConsumerModule,
    { bufferLogs: true },
  );
  app.useLogger(app.get(PinoLogger));
  const logger = new Logger('NotificationsConsumerBootstrap');

  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  armShutdownWatchdog(
    app
      .get<ConfigService<ConsumerEnv, true>>(ConfigService)
      .get('SHUTDOWN_TIMEOUT_MS', { infer: true }),
    logger,
  );

  await app.init();
  logger.log('Consumer de notificações no ar');
}

bootstrap().catch((err: unknown) => {
  new Logger('NotificationsConsumerBootstrap').error(
    'Erro fatal na inicialização do consumer de notificações',
    err instanceof Error ? err.stack : err,
  );
  process.exit(1);
});
