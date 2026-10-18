import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CursorPaginationDto } from '../../common/dto/pagination.dto';
import { CurrentUser, type AuthenticatedUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CreateTaskCommand } from './commands/create-task.command';
import { GetTasksQuery } from './queries/get-tasks.query';
import { CreateTaskDto } from './dto/create-task.dto';

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
}
