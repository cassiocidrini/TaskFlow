import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
  RequestMethod,
} from '@nestjs/common';
import { VersionGateMiddleware } from './version-gate.middleware';
import { VersionPolicyService } from './version-policy.service';

/**
 * Política de versão do app (Módulo 14.2): o serviço que lê a política e o middleware que a aplica.
 *
 * O middleware é registrado AQUI, como middleware de módulo, em todas as rotas (o mesmo padrão de rota do
 * `nestjs-pino`). A ordem importa: este módulo vem depois do `LoggerModule` no `AppModule`, então o log de acesso já
 * está montado quando o 426 sai (problema 3 do Módulo 14). O `PrismaService` vem do `PrismaModule` global.
 */
@Module({
  providers: [VersionPolicyService],
  exports: [VersionPolicyService],
})
export class VersionPolicyModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(VersionGateMiddleware)
      .forRoutes({ path: '{/*splat}', method: RequestMethod.ALL });
  }
}
