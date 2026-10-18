import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, type AuthenticatedUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectsService } from './projects.service';

@Controller('projects')
@UseGuards(JwtAuthGuard) // ← guard no nível da CLASSE: nenhuma rota nasce pública por esquecimento
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  create(@Body() dto: CreateProjectDto, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.create(user.userId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.projects.listByOwner(user.userId);
  }

  @Get(':projectId')
  findOne(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projects.findOwned(projectId, user.userId);
  }
}
