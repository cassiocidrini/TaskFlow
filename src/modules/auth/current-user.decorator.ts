import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/** Formato do usuário que o JwtStrategy.validate() anexa em request.user */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);
