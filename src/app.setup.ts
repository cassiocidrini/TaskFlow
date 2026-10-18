import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
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

/**
 * Documentação interativa em /docs (OpenAPI). Gerada a partir dos DTOs e controllers
 * pelo plugin do Nest CLI (nest-cli.json) — não diverge do código.
 *
 * Chamada SÓ pelo main.ts e NUNCA em produção: expor o mapa da API publicamente
 * facilita reconhecimento por atacantes (OWASP A05 — Security Misconfiguration).
 */
export function setupSwagger(app: INestApplication): void {
  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('TaskFlow API')
      .setDescription(
        'Gestão de tarefas com CQRS + Event Sourcing. Fluxo: POST /auth/register → POST /auth/login → ' +
          'clique em "Authorize" e cole o accessToken → POST /projects → POST /projects/{id}/tasks.',
      )
      .setVersion('1.0')
      .addBearerAuth()
      // Aplica o JWT do botão "Authorize" a todas as rotas (sem decorar controller por controller)
      .addSecurityRequirements('bearer')
      .build(),
  );

  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true }, // o token sobrevive a um F5
  });
}
