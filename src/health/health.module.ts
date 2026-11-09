import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './database.health';
import { DrainingConnectionMiddleware } from './draining-connection.middleware';
import { HealthController } from './health.controller';
import { ShutdownState } from './shutdown-state';

/**
 * Health checks (`/health/live`, `/health/ready`) e o início do graceful shutdown (`ShutdownState` +
 * `Connection: close` durante a drenagem, aplicado a TODAS as rotas).
 *
 * `errorLogStyle: 'json'`: quando um check falha, o terminus registra o resultado; em JSON ele sai na mesma linha
 * estruturada do pino, em vez de um bloco de texto colorido.
 */
@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, ShutdownState],
})
export class HealthModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(DrainingConnectionMiddleware).forRoutes('*path');
  }
}
