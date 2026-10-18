import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Formato do usuário que o {@link JwtStrategy.validate} anexa em `request.user`. */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * `@CurrentUser()` — injeta no handler o usuário do JWT já validado.
 *
 * Por que um decorator, e não `@Req() req` + `req.user`? Tipagem (`AuthenticatedUser`, não `any`) e uma
 * regra de segurança explícita no código: **a identidade vem do token, nunca do body ou da URL**.
 * Se o `userId` pudesse vir do cliente, bastaria enviar o de outra pessoa (IDOR, OWASP A01).
 *
 * Só faz sentido em rotas protegidas pelo `JwtAuthGuard`; sem ele, `request.user` é `undefined`.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
