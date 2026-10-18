import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CqrsModule } from '@nestjs/cqrs';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { validateEnv, type Env } from './config/env.schema';
import { PrismaModule } from './prisma/prisma.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { AuthModule } from './modules/auth/auth.module';
import { ProjectsModule } from './modules/projects/projects.module';

/**
 * Módulo raiz: compõe a aplicação.
 *
 * Decisões que valem para todos os módulos:
 * - **Fail-fast de configuração:** o `ConfigModule` valida o ambiente com `zod` no momento em que ESTE módulo é
 *   carregado. Configuração inválida impede o boot, listando todos os erros (OWASP A05). Consequência para os
 *   testes E2E: o `AppModule` precisa ser carregado DEPOIS de o teste definir o ambiente (`startE2EApp`).
 * - **Rate limit global (OWASP A04):** 100 req/min por IP em todas as rotas, com limites mais rígidos por rota
 *   onde há risco de força bruta (`@Throttle` no login e no cadastro).
 * - **Ordem dos imports = ordem de dependência** (Auth → Projects → Tasks), só para leitura: o Nest resolve
 *   qualquer ordem.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    PrismaModule,
    CqrsModule.forRoot(),
    AuthModule,
    ProjectsModule,
    TasksModule,
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        // O guard fica SEMPRE registrado e decide em runtime se pula: a estrutura da aplicação é a mesma em
        // teste e em produção. Desligado só com DISABLE_THROTTLE=true (testes E2E e de carga), nunca em produção.
        skipIf: () => config.get('DISABLE_THROTTLE', { infer: true }),
      }),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    // APP_GUARD = guard GLOBAL: aplicado a toda rota sem precisar anotá-la (secure by default)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
