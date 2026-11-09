import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { CORRELATION_ID_HEADER, correlationIdMiddleware } from './common/correlation/correlation-id.middleware';
import type { Env } from './config/env.schema';

/**
 * Configuração HTTP global da aplicação — ÚNICA fonte, usada pelo `main.ts` E pelos testes E2E.
 *
 * Por que uma função compartilhada: antes, o E2E montava Helmet e `ValidationPipe` "na mão" — sem CORS e sem a
 * conversão implícita de tipos. Ou seja, testava uma aplicação DIFERENTE da de produção. Agora o que o E2E
 * valida é exatamente o que roda.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // PRIMEIRO middleware: o correlationId precisa existir antes de qualquer outro (inclusive do log de acesso).
  // Os middlewares de módulo (o pino-http do nestjs-pino) só são montados no init/listen, então rodam depois deste.
  app.use(correlationIdMiddleware);

  // ~15 headers de segurança numa linha: anti-clickjacking, HSTS, nosniff, CSP… (OWASP A05)
  app.use(helmet());

  // Lista EXPLÍCITA de origens vinda do ambiente (CORS_ORIGINS), validada como URLs.
  // Nunca `origin: '*'`: qualquer site poderia chamar a API com a sessão do usuário (OWASP A05).
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', CORRELATION_ID_HEADER],
    // Sem isto, o JavaScript de um front em outra origem não consegue LER o header da resposta (só o envia)
    exposedHeaders: [CORRELATION_ID_HEADER],
  });

  // Validação global de TODA entrada. whitelist + forbidNonWhitelisted = defesa contra mass assignment:
  // um `isAdmin: true` ou `ownerId` no body vira 400, em vez de chegar ao handler (OWASP A03/API6).
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
        [
          'API de gestão de tarefas com **CQRS + Event Sourcing**: o estado de cada tarefa é derivado de eventos imutáveis.',
          '',
          '**Como começar:** `POST /auth/register` → `POST /auth/login` → botão **Authorize** (cole o `accessToken`) → ' +
            '`POST /projects` → `POST /projects/{projectId}/tasks`.',
          '',
          '**Códigos de resposta:** `400` entrada inválida · `401` sem token ou token inválido · ' +
            '`404` recurso inexistente **ou de outro usuário** (a API não confirma a existência de recursos alheios) · ' +
            '`409` regra de negócio violada ou conflito de concorrência · `429` limite de requisições excedido.',
          '',
          '**Correlação:** toda resposta traz o header `X-Correlation-Id`. Envie o seu (até 64 caracteres: letras, ' +
            'dígitos, `.`, `_`, `-`) para rastrear a chamada de ponta a ponta; ausente ou inválido, a API gera um UUID. ' +
            'Cite esse id ao reportar um problema.',
        ].join('\n'),
      )
      .setVersion('1.0')
      .addGlobalParameters({
        in: 'header',
        name: CORRELATION_ID_HEADER,
        required: false,
        description:
          'Id de correlação (até 64 caracteres: letras, dígitos, `.`, `_`, `-`). Devolvido na resposta; ' +
          'se ausente ou inválido, a API gera um UUID.',
        schema: { type: 'string', maxLength: 64, pattern: '^[A-Za-z0-9._-]{1,64}$' },
      })
      // O cadeado aparece só nas rotas marcadas com @ApiBearerAuth(): register e login ficam públicos
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth', 'Cadastro, login (emissão de JWT) e identificação do usuário')
      .addTag('projects', 'Projetos do usuário autenticado (cada projeto tem um dono)')
      .addTag('tasks', 'Tarefas event-sourced: criação, ciclo de vida, listagem e histórico de eventos')
      .addTag('app', 'Rota raiz (smoke test)')
      .build(),
  );

  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { persistAuthorization: true }, // o token sobrevive a um F5
  });
}
