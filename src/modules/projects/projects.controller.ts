import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentUser, type AuthenticatedUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateProjectDto } from './dto/create-project.dto';
import { ProjectResponseDto } from './dto/project.response';
import { ProjectsService } from './projects.service';

/**
 * Borda HTTP dos projetos.
 *
 * **`@UseGuards` na CLASSE (*secure by default*):** toda rota nova deste controller já nasce exigindo JWT.
 * Foi a falta desse padrão que deixou as rotas de tarefas abertas antes da correção (OWASP A01).
 *
 * Todas as operações são escopadas ao usuário do token: o `userId` vem do `@CurrentUser()`, nunca da
 * requisição, e projeto de outro usuário responde 404 — indistinguível de "não existe".
 */
@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
@UseGuards(JwtAuthGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Post()
  @ApiOperation({ summary: 'Criar projeto', description: 'O usuário autenticado se torna o dono do projeto.' })
  @ApiResponse({ status: 201, description: 'Projeto criado.', type: ProjectResponseDto })
  @ApiResponse({ status: 400, description: 'Entrada inválida ou campo não permitido no body (ex.: `ownerId`).' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido.' })
  create(@Body() dto: CreateProjectDto, @CurrentUser() user: AuthenticatedUser) {
    return this.projects.create(user.userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'Listar meus projetos', description: 'Somente os projetos do usuário autenticado, mais recentes primeiro.' })
  @ApiResponse({ status: 200, description: 'Lista de projetos (pode ser vazia).', type: [ProjectResponseDto] })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido.' })
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.projects.listByOwner(user.userId);
  }

  @Get(':projectId')
  @ApiOperation({ summary: 'Detalhar projeto' })
  @ApiParam({ name: 'projectId', description: 'ID do projeto (UUID v4)', example: 'bab4a090-6a9f-41eb-b3f6-b0302ee4cf87' })
  @ApiResponse({ status: 200, description: 'Projeto encontrado.', type: ProjectResponseDto })
  @ApiResponse({ status: 400, description: '`projectId` não é um UUID v4.' })
  @ApiResponse({ status: 401, description: 'Token ausente ou inválido.' })
  @ApiResponse({ status: 404, description: 'Projeto inexistente **ou de outro usuário** (anti-enumeração).' })
  findOne(
    // Validado ANTES de tocar no banco: entrada malformada vira 400, não uma query inútil (OWASP A03)
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.projects.findOwned(projectId, user.userId);
  }
}
