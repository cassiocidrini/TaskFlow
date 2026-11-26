import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import type { Express } from 'express';
import helmet from 'helmet';
import { APP_VERSION_HEADER, PLATFORM_HEADER } from './common/client/client-info';
import { createClientInfoMiddleware } from './common/client/client-info.middleware';
import {
  APP_RECOMMENDED_VERSION_HEADER,
  APP_UPDATE_HEADER,
  APP_UPDATE_REQUIRED,
} from './common/client/version-gate.middleware';
import { CORRELATION_ID_HEADER, correlationIdMiddleware } from './common/correlation/correlation-id.middleware';
import { DEPRECATION_HEADERS } from './common/deprecation/deprecation';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAYED_HEADER } from './common/idempotency/idempotency-key';
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

  // Atrás de um proxy (o Envoy do Gateway, no Kubernetes), o IP da conexão é o do PROXY, igual para todo cliente:
  // o rate limit, que usa `req.ip` como chave, virava um balde só, e um robô no cadastro bloqueava todos os usuários
  // (medido no Módulo 02, 2.5). O número de saltos confiáveis está no TRUST_PROXY_HOPS (env.schema.ts)
  const trustProxyHops = config.get('TRUST_PROXY_HOPS', { infer: true });
  if (trustProxyHops > 0) {
    const express: Express = app.getHttpAdapter().getInstance();
    express.set('trust proxy', trustProxyHops);
  }

  // PRIMEIRO middleware: o correlationId precisa existir antes de qualquer outro (inclusive do log de acesso).
  // Os middlewares de módulo (o pino-http do nestjs-pino) só são montados no init/listen, então rodam depois deste.
  app.use(correlationIdMiddleware);
  // Logo depois: quem é o cliente (plataforma e versão do app). Antes dos guards, para a versão mínima (14.2) valer
  // até em rota pública; e antes do log de acesso, que registra o cliente
  app.use(createClientInfoMiddleware());
  // A versão mínima (14.2) NÃO entra aqui: é middleware de módulo (VersionPolicyModule), para rodar depois do log de
  // acesso e ainda antes dos guards

  // ~15 headers de segurança numa linha: anti-clickjacking, HSTS, nosniff, CSP… (OWASP A05)
  app.use(helmet());

  // Lista EXPLÍCITA de origens vinda do ambiente (CORS_ORIGINS), validada como URLs.
  // Nunca `origin: '*'`: qualquer site poderia chamar a API com a sessão do usuário (OWASP A05).
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    // Sem os headers do cliente aqui, o preflight do navegador barraria o front web que os envia
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      CORRELATION_ID_HEADER,
      PLATFORM_HEADER,
      APP_VERSION_HEADER,
      IDEMPOTENCY_KEY_HEADER, // Módulo 14.5
    ],
    // Sem isto, o JavaScript de um front em outra origem não consegue LER o header da resposta (só o envia)
    exposedHeaders: [
      CORRELATION_ID_HEADER,
      APP_UPDATE_HEADER,
      APP_RECOMMENDED_VERSION_HEADER,
      ...DEPRECATION_HEADERS,
      IDEMPOTENT_REPLAYED_HEADER,
    ],
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
  SwaggerModule.setup('docs', app, buildOpenApiDocument(app), {
    swaggerOptions: { persistAuthorization: true }, // o token sobrevive a um F5
  });
}

/**
 * O documento OpenAPI da API: a MESMA fonte para o `/docs` e para o snapshot versionado em `docs/api/openapi.json`
 * (Módulo 14.3), gerado por `scripts/openapi/snapshot.mjs` a partir do `dist/`. Duas montagens divergiriam, e o
 * snapshot deixaria de ser o contrato que a API serve.
 *
 * Não precisa de banco nem de servidor escutando: lê só os metadados dos controllers e DTOs (que o plugin do Swagger
 * no `nest build` completa a partir dos tipos e do `class-validator`).
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
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
          '',
          '**Cliente:** apps e front web devem enviar `X-Platform` (`ios`, `android` ou `web`) e `X-App-Version` ' +
            '(`MAJOR.MINOR.PATCH`, a versão de loja ou do build). São opcionais; ausentes ou inválidos, a chamada segue ' +
            'como cliente desconhecido.',
          '',
          '**Versão mínima:** abaixo da versão mínima da plataforma, qualquer rota responde `426` com ' +
            `\`code: "${APP_UPDATE_REQUIRED}"\` e a \`minVersion\`. Abaixo da recomendada, a resposta é normal e traz ` +
            '`X-App-Update: recommended` e `X-App-Recommended-Version`. Cheque o `code`, não só o status.',
          '',
          '**Compatibilidade (ADR-0012):** a API evolui sem versão na URL, só com mudanças compatíveis (campo ou rota ' +
            'novos, opcionais). Um campo que precisa mudar é depreciado antes (`deprecated` aqui, e os headers ' +
            '`Deprecation`/`Sunset` na resposta), com pelo menos 90 dias até sair. Versões do app lançadas nos ' +
            'últimos 6 meses são suportadas; abaixo disso, a versão mínima pode responder `426`. Ignore campos que ' +
            'você não conhece: a API acrescenta campos sem avisar.',
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
      .addGlobalParameters(
        {
          in: 'header',
          name: PLATFORM_HEADER,
          required: false,
          description: 'Plataforma do cliente. Ausente ou fora da lista: cliente desconhecido (nunca 400).',
          schema: { type: 'string', enum: ['ios', 'android', 'web'] },
        },
        {
          in: 'header',
          name: APP_VERSION_HEADER,
          required: false,
          description:
            'Versão do app (de loja) ou do build do front web, `MAJOR.MINOR.PATCH`. Usada para compatibilidade, ' +
            'nunca para autorização: o valor é controlado pelo cliente.',
          schema: { type: 'string', pattern: '^(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,3})\\.(0|[1-9]\\d{0,3})$' },
        },
      )
      .addGlobalResponse({
        status: 426,
        description:
          `Versão do app abaixo da mínima da plataforma (\`code: "${APP_UPDATE_REQUIRED}"\`, com \`platform\` e ` +
          '`minVersion`). Só para quem envia `X-Platform` e `X-App-Version`.',
      })
      // O cadeado aparece só nas rotas marcadas com @ApiBearerAuth(): register e login ficam públicos
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
      .addTag('auth', 'Cadastro, login (emissão de JWT) e identificação do usuário')
      .addTag('projects', 'Projetos do usuário autenticado (cada projeto tem um dono)')
      .addTag('tasks', 'Tarefas event-sourced: criação, ciclo de vida, listagem e histórico de eventos')
      .addTag('notifications', 'Notificações do usuário, geradas a partir dos eventos de tarefa publicados no Kafka')
      .addTag('features', 'Feature flags avaliadas para o usuário e o app (só o resultado; as regras ficam no servidor)')
      .addTag('app', 'Rota raiz (smoke test) e health checks para o orquestrador (liveness e readiness)')
      .build(),
  );
}
