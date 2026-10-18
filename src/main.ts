// ORDEM CRÍTICA dos dois primeiros imports:
// 1º `./env`     — carrega o .env (o tracing já precisa das variáveis);
// 2º `./tracing` — o OpenTelemetry aplica patches em http/express/pg NO MOMENTO em que eles são carregados.
//                  Se o Nest fosse importado antes, essas bibliotecas escapariam da instrumentação e parte dos
//                  spans simplesmente não apareceria no Jaeger — sem nenhum erro visível.
import './env';
import './tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureApp, setupSwagger } from './app.setup';
import type { Env } from './config/env.schema';

/**
 * Ponto de entrada do processo HTTP.
 *
 * Fica só com o que é EXCLUSIVO do processo real (carregar ambiente, tracing, escutar a porta). A configuração
 * HTTP mora em `configureApp()`, compartilhada com os testes E2E.
 */
async function bootstrap() {
  // Se o ambiente for inválido, o ConfigModule lança AQUI, listando todos os erros (fail-fast).
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  configureApp(app); // Helmet, CORS e ValidationPipe — a mesma configuração usada nos testes E2E

  const config = app.get<ConfigService<Env, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  // Documentação interativa só fora de produção: em produção, ela entregaria o mapa da API (OWASP A05)
  if (!isProduction) {
    setupSwagger(app);
  }

  await app.listen(port);
  logger.log(`TaskFlow rodando em http://localhost:${port}`);
  if (!isProduction) {
    logger.log(`Swagger (documentação interativa) em http://localhost:${port}/docs`);
  }
}

// Falha no boot = processo encerrado com código ≠ 0: orquestradores (Docker, Kubernetes) detectam e reagem,
// em vez de manterem no ar um processo que não atende ninguém.
bootstrap().catch((err: unknown) => {
  new Logger('Bootstrap').error('Erro fatal na inicialização', err instanceof Error ? err.stack : err);
  process.exit(1);
});
