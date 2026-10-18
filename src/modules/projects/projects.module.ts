import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

/**
 * Módulo de projetos.
 *
 * `exports: [ProjectsService]` é uma decisão de encapsulamento: o `TasksModule` precisa do `assertOwner`
 * para autorizar cada operação em tarefas. Exportar declara EXPLICITAMENTE o que este módulo oferece aos
 * outros — o restante (controller, detalhes de persistência) continua privado.
 */
@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
