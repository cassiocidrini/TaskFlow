import './env';
import './tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import type { Env } from './config/env.schema';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  configureApp(app); // Helmet, CORS e ValidationPipe — a mesma configuração usada nos testes E2E

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  if (!isProduction) {
    setupSwagger(app);
  }

  await app.listen(port);
  logger.log(`TaskFlow rodando em http://localhost:${port}`);
  if (!isProduction) {
    logger.log(`Swagger (documentação interativa) em http://localhost:${port}/docs`);
  }
}

bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error('Erro fatal na inicialização', err instanceof Error ? err.stack : err);
  process.exit(1);
});
