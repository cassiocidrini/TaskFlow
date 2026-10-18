import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { StringValue } from 'ms';
import type { Env } from '../../config/env.schema';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from './jwt.strategy';

/**
 * Módulo de autenticação: cadastro, login e validação de JWT.
 *
 * **`registerAsync` + `inject: [ConfigService]`, e não `register({...})`:** o `register` leria o ambiente
 * no momento do import — antes de o `ConfigModule` validar as variáveis e, nos testes E2E, antes de o
 * teste definir o próprio segredo. A *factory* roda na hora da injeção, com o `ConfigService` pronto
 * (Factory Method aplicado à configuração).
 */
@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        secret: config.get('JWT_SECRET', { infer: true }),
        signOptions: {
          // Cast seguro: o envSchema já garantiu o formato <número><s|m|h|d> via regex
          expiresIn: config.get('JWT_EXPIRES_IN', { infer: true }) as StringValue,
          // Mesmo algoritmo que o JwtStrategy aceita na verificação (anti algorithm confusion)
          algorithm: 'HS256',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService],
})
export class AuthModule {}
