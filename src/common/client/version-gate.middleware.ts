import { Injectable, type NestMiddleware } from '@nestjs/common';
import { metrics } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { isHealthCheck } from '../../health/health-paths';
import { currentRequestSpan } from '../telemetry/request-span';
import { formatAppVersion } from './app-version';
import { UNKNOWN_CLIENT } from './client-info';
import type { RequestWithClient } from './client-info.middleware';
import { evaluateClient } from './version-policy';
import { VersionPolicyService } from './version-policy.service';

/** Código estável que o app checa (o status sozinho não basta: ver o TSDoc do middleware). */
export const APP_UPDATE_REQUIRED = 'APP_UPDATE_REQUIRED';
/** Headers do aviso de atualização recomendada (o *soft update*): a requisição é atendida normalmente. */
export const APP_UPDATE_HEADER = 'X-App-Update';
export const APP_RECOMMENDED_VERSION_HEADER = 'X-App-Recommended-Version';

/** Corpo do 426, no mesmo formato dos erros do Nest (`statusCode`, `error`, `message`) mais o que o app usa. */
export interface UpdateRequiredBody {
  statusCode: 426;
  error: 'Upgrade Required';
  code: typeof APP_UPDATE_REQUIRED;
  message: string;
  platform: string;
  minVersion: string;
}

/**
 * Aplica a política de versão do app (Módulo 14.2), logo depois da identificação do cliente:
 * - abaixo da mínima → **426** com `code: APP_UPDATE_REQUIRED`: o app mostra a tela de "atualize na loja" (no web,
 *   "recarregue a página");
 * - abaixo da recomendada → atende e avisa (`X-App-Update: recommended` + a versão), para um aviso que dá para fechar;
 * - o resto (inclusive quem não se identifica) → passa.
 *
 * **Middleware de módulo do Nest, e não `app.use()`:** todo middleware roda antes dos guards, então o app antigo
 * recebe o 426 mesmo deslogado (se recebesse 401, o usuário tentaria fazer login de novo num app que não funciona
 * mais). E, registrado pelo `VersionPolicyModule`, que vem depois do `LoggerModule`, ele roda DEPOIS do log de acesso
 * do `pino-http`: como `app.use()`, ele respondia antes de o logger existir, e o 426 não aparecia em log nenhum
 * (problema 3 do Módulo 14).
 *
 * **Por que 426, com a ressalva:** o `426 Upgrade Required` foi criado para upgrade de PROTOCOLO (a RFC 9110 manda
 * responder com o header `Upgrade`), mas virou a convenção de mercado para "atualize o app". O que o app deve checar
 * é o `code` do corpo, que é nosso e estável; o status é só a primeira pista.
 *
 * O contador é criado no construtor, quando o Nest monta a aplicação: depois de o SDK do OpenTelemetry registrar o
 * provider de métricas (a API de métricas não tem provider "proxy").
 */
@Injectable()
export class VersionGateMiddleware implements NestMiddleware {
  private readonly blocked = metrics
    .getMeter('taskflow-api')
    .createCounter('taskflow_app_update_required', {
      description:
        'Requisições recusadas com 426 por versão do app abaixo da mínima, por plataforma',
    });

  constructor(private readonly policies: VersionPolicyService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const { blocked, policies } = this;
    if (isHealthCheck(req.url)) return next(); // o probe do orquestrador não é um app
    const client = (req as RequestWithClient).appClient ?? UNKNOWN_CLIENT;

    policies
      .policyFor(client.platform)
      .then((policy) => {
        const decision = evaluateClient(client, policy);
        if (decision.kind === 'update-required') {
          blocked.add(1, { platform: client.platform });
          currentRequestSpan()?.setAttribute(
            'taskflow.client.update_required',
            true,
          );
          const body: UpdateRequiredBody = {
            statusCode: 426,
            error: 'Upgrade Required',
            code: APP_UPDATE_REQUIRED,
            message:
              'Esta versão do app não é mais suportada. Atualize para continuar.',
            platform: client.platform,
            minVersion: formatAppVersion(decision.minVersion),
          };
          res.status(426).json(body);
          return;
        }
        if (decision.kind === 'update-recommended') {
          res.setHeader(APP_UPDATE_HEADER, 'recommended');
          res.setHeader(
            APP_RECOMMENDED_VERSION_HEADER,
            formatAppVersion(decision.recommendedVersion),
          );
        }
        next();
      })
      .catch(next);
  }
}
