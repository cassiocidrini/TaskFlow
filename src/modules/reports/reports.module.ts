import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Lado da API do contexto de relatórios: só LEITURA (`GET /projects/:projectId/stats`). A escrita mora no processo
 * consumer (`consumer/reports-consumer.module.ts`), que este módulo não importa. `ProjectsModule` pelo `assertOwner`.
 */
@Module({
  imports: [ProjectsModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  // A listagem de tarefas lê os números do projeto atrás da flag `task-list-with-stats` (Módulo 14.7)
  exports: [ReportsService],
})
export class ReportsModule {}
