import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import type { Env } from './config/env.schema';

/**
 * Configuração HTTP global da aplicação — ÚNICA fonte, usada pelo main.ts E pelos testes E2E.
 * Se o E2E montasse a app "na mão", testaria uma configuração diferente da de produção.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  app.use(helmet());

  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // remove atributos não declarados no DTO
      forbidNonWhitelisted: true, // lança erro se vier atributo extra
      transform: true, // converte tipos automaticamente
      transformOptions: { enableImplicitConversion: true },
    }),
  );
}
