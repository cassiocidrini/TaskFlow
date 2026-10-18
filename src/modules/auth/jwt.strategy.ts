import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Env } from '../../config/env.schema';

interface JwtPayload {
  sub: string;
  email: string;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
      // Aceita SOMENTE o algoritmo que usamos para assinar (evita "algorithm confusion")
      algorithms: ['HS256'],
    });
  }

  async validate(payload: JwtPayload) {
    return { userId: payload.sub, email: payload.email };
  }
}
