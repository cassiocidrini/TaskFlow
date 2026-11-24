import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { type ClientInfo, UNKNOWN_CLIENT } from './client-info';
import type { RequestWithClient } from './client-info.middleware';

/**
 * `@AppClient()`: injeta no handler a plataforma e a versão de quem chamou (Módulo 14.1), já validadas pelo
 * `clientInfoMiddleware`.
 *
 * Pelo mesmo motivo do `@CurrentUser()`: tipado e sem o handler mexer no `req`. A diferença que importa: o
 * `@CurrentUser()` vem de um token assinado e é identidade; este vem de headers que o cliente controla e serve só para
 * compatibilidade (ver `ClientInfo`).
 *
 * Sem o middleware (um teste que monta o app sem o `configureApp`), devolve o cliente desconhecido em vez de
 * `undefined`: o handler nunca precisa checar.
 */
export const AppClient = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ClientInfo =>
    ctx.switchToHttp().getRequest<RequestWithClient>().appClient ??
    UNKNOWN_CLIENT,
);
