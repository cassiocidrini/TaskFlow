import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectsService],
  // Exportado para o TasksModule verificar posse do projeto (assertOwner)
  exports: [ProjectsService],
})
export class ProjectsModule {}
