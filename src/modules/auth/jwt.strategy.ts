import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Env } from '../../config/env.schema';
import type { AuthenticatedUser } from './current-user.decorator';

/** Claims que o {@link AuthService.login} coloca no token. */
interface JwtPayload {
  sub: string;
  email: string;
}

/**
 * Validação do JWT em cada requisição protegida (Passport, estratégia `'jwt'`).
 *
 * Endurecimento aplicado (OWASP A02/A07):
 * - **Assinatura e expiração verificadas** (`ignoreExpiration: false`): token adulterado ou vencido → 401.
 * - **Algoritmo fixo em `HS256`:** bloqueia o ataque de *algorithm confusion*, em que o atacante forja um
 *   token com `alg: none` ou troca o algoritmo. Quem assina (`auth.module.ts`) e quem verifica concordam
 *   EXPLICITAMENTE, sem depender do default da biblioteca.
 * - **Segredo vindo do `ConfigService`:** validado no boot (≥ 32 caracteres); a app não sobe sem ele.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
      algorithms: ['HS256'],
    });
  }

  /**
   * Chamado só DEPOIS de a assinatura e a expiração serem validadas. O retorno vira `request.user`,
   * lido pelo decorator `@CurrentUser()`. É daqui — e nunca do body — que sai o `userId` usado nas
   * regras de autorização (anti-IDOR, OWASP A01).
   */
  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    return { userId: payload.sub, email: payload.email };
  }
}
