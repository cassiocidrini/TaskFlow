import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CurrentUser,
  type AuthenticatedUser,
} from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ProjectStatsDto } from './dto/project-stats.response';
import { ReportsService } from './reports.service';

/**
 * Borda HTTP dos relatórios (Módulo 13.6a). Tag `projects`: para quem consome a API, são números DO projeto; que
 * venham de outro contexto (o consumer `reports`) é detalhe interno. `@UseGuards` na classe: secure by default.
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects/:projectId/stats')
@UseGuards(JwtAuthGuard)
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get()
  @ApiOperation({
    summary: 'Números do projeto',
    description:
      'Tarefas por status, abertas sem responsável e lead time médio. Calculados pelo consumer `reports` a partir dos eventos publicados no Kafka: eventualmente consistentes. `asOf` é o instante do evento mais recente refletido.',
  })
  @ApiParam({
    name: 'projectId',
    description: 'ID do projeto (UUID v4)',
    example: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87',
  })
  @ApiResponse({
    status: 200,
    description:
      'Números do projeto (zeros e `asOf: null` antes do primeiro evento).',
    type: ProjectStatsDto,
  })
  @ApiResponse({ status: 400, description: '`projectId` não é um UUID v4.' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido.' })
  @ApiResponse({
    status: 404,
    description:
      'Projeto inexistente **ou de outro usuário** (anti-enumeração).',
  })
  get(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ProjectStatsDto> {
    return this.reports.statsFor(projectId, user.userId);
  }
}
