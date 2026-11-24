import { metrics } from '@opentelemetry/api';
import type { NextFunction, Request, Response } from 'express';
import { isHealthCheck } from '../../health/health-paths';
import { currentRequestSpan } from '../telemetry/request-span';
import {
  appVersionLabel,
  type ClientInfo,
  describeClient,
  resolveClientInfo,
} from './client-info';

/** Onde o middleware guarda o cliente no request: lido pelo `@AppClient()` e pelo log de acesso. */
export interface RequestWithClient {
  appClient?: ClientInfo;
}

export const CLIENT_PLATFORM_SPAN_ATTRIBUTE = 'taskflow.client.platform';
export const CLIENT_APP_VERSION_SPAN_ATTRIBUTE = 'taskflow.client.app_version';

/**
 * Cria o middleware que identifica o cliente em cada requisição (Módulo 14.1): resolve `X-Platform` e
 * `X-App-Version`, anexa o resultado ao request, grava no span HTTP e conta na métrica `taskflow_app_requests_total`.
 *
 * **Fábrica, e não uma função solta:** o contador é criado AQUI, quando o `configureApp` roda. A API de métricas do
 * OpenTelemetry não tem provider "proxy" como a de traces: um `getMeter` executado na importação do arquivo, antes de
 * o SDK registrar o provider, devolveria um contador que nunca exporta nada.
 *
 * **Middleware Express, logo depois do de correlação:** roda antes dos guards e do roteamento, então o cliente existe
 * até para uma requisição barrada pelo JWT ou que não casa com rota nenhuma. É o que a versão mínima (14.2) vai
 * precisar: o app antigo recebe o aviso de atualização mesmo deslogado.
 *
 * O que vai para cada destino, por cardinalidade: versão completa no span e no log (cardinalidade alta não custa
 * nada ali); `MAJOR.MINOR` limitado na métrica (cada valor é uma série no Prometheus). `userId` nunca vira label.
 */
export function createClientInfoMiddleware() {
  const requests = metrics
    .getMeter('taskflow-api')
    .createCounter('taskflow_app_requests', {
      description:
        'Requisições por plataforma e versão do app (MAJOR.MINOR): quantos clientes ainda estão abaixo de uma versão',
    });

  return function clientInfoMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    const client = resolveClientInfo(
      req.headers['x-platform'],
      req.headers['x-app-version'],
    );
    (req as RequestWithClient).appClient = client;

    const described = describeClient(client);
    // No span do REQUEST: o ativo, aqui dentro, é o span do próprio middleware (problema 1 do Módulo 14)
    const span = currentRequestSpan();
    span?.setAttribute(CLIENT_PLATFORM_SPAN_ATTRIBUTE, described.platform);
    if (described.appVersion) {
      span?.setAttribute(
        CLIENT_APP_VERSION_SPAN_ATTRIBUTE,
        described.appVersion,
      );
    }

    // Probes do orquestrador não mandam headers: contariam como `unknown` a cada poucos segundos, sem informação
    if (!isHealthCheck(req.url)) {
      requests.add(1, {
        platform: client.platform,
        app_version: appVersionLabel(client),
      });
    }
    next();
  };
}
