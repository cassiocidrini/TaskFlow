import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Módulo de acesso ao PostgreSQL.
 *
 * `@Global()` é uma exceção consciente: praticamente todo módulo precisa do banco, e importá-lo em cada um
 * seria só repetição. Para dependências de domínio (ex.: `ProjectsService`), o projeto prefere imports
 * explícitos — o grafo de dependências documenta a arquitetura.
 *
 * Um único `PrismaService` (singleton do container de DI) = um único pool de conexões para a aplicação inteira.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
