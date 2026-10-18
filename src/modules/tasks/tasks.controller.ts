import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, type AuthenticatedUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateTaskCommand } from './commands/create-task.command';
import type { TaskSnapshot } from './commands/task-command.runner';
import {
  AssignTaskCommand,
  ChangeTaskStatusCommand,
  CompleteTaskCommand,
} from './commands/task-lifecycle.commands';
import { GetTasksQuery } from './queries/get-tasks.query';
import { GetTaskHistoryQuery } from './queries/get-task-history.query';
import type { TaskHistory } from './queries/get-task-history.handler';
import { CreateTaskDto } from './dto/create-task.dto';
import { AssignTaskDto, ChangeTaskStatusDto } from './dto/task-lifecycle.dto';

// Pipe compartilhado: toda rota valida os IDs da URL como UUID v4 (400 antes de tocar no banco)
const UUID_V4 = new ParseUUIDPipe({ version: '4' });

@Controller('projects/:projectId/tasks')
@UseGuards(JwtAuthGuard) // ← todas as rotas de tarefas exigem token (antes: abertas a qualquer um)
export class TasksController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  async create(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Body() body: CreateTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const taskId = await this.commandBus.execute(
      new CreateTaskCommand(
        user.userId,
        projectId,
        body.title,
        body.assigneeId,
        body.dueDate ? new Date(body.dueDate) : undefined, // Converte string ISO para Date
      ),
    );
    return { taskId };
  }

  @Get()
  async list(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Query() page: CursorPaginationDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.queryBus.execute(new GetTasksQuery(user.userId, projectId, page.limit, page.cursor));
  }

  /** Linha do tempo completa da tarefa + estado atual reconstruído dos eventos (auditoria). */
  @Get(':taskId/history')
  history(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskHistory> {
    return this.queryBus.execute(new GetTaskHistoryQuery({ userId: user.userId, projectId, taskId }));
  }

  // ============================================================
  // Ciclo de vida (Event Sourcing): cada rota vira UM comando de domínio.
  // Respostas: 200 + snapshot · 404 projeto/tarefa alheios ou inexistentes · 409 regra violada ou conflito de versão
  // ============================================================

  @Patch(':taskId/assignee')
  assign(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @Body() body: AssignTaskDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskSnapshot> {
    return this.commandBus.execute(new AssignTaskCommand({ userId: user.userId, projectId, taskId }, body.assigneeId));
  }

  @Patch(':taskId/status')
  changeStatus(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @Body() body: ChangeTaskStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskSnapshot> {
    return this.commandBus.execute(new ChangeTaskStatusCommand({ userId: user.userId, projectId, taskId }, body.status));
  }

  @Post(':taskId/complete')
  @HttpCode(HttpStatus.OK) // ação sobre recurso existente: 200, não 201 (nada foi "criado")
  complete(
    @Param('projectId', UUID_V4) projectId: string,
    @Param('taskId', UUID_V4) taskId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<TaskSnapshot> {
    return this.commandBus.execute(new CompleteTaskCommand({ userId: user.userId, projectId, taskId }));
  }
}
