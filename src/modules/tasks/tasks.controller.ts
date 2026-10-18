import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CommandBus, QueryBus } from '@nestjs/cqrs';
import { CreateTaskCommand } from './commands/create-task.command';
import { GetTasksQuery } from './queries/get-tasks.query';
import { CreateTaskDto } from './dto/create-task.dto';

@Controller('projects/:projectId/tasks')
export class TasksController {
  constructor(
    private readonly commandBus: CommandBus,
    private readonly queryBus: QueryBus,
  ) {}

  @Post()
  async create(
    @Param('projectId') projectId: string,
    @Body() body: CreateTaskDto,              // ← usa o DTO
  ) {
    const taskId = await this.commandBus.execute(
      new CreateTaskCommand(
        projectId, 
        body.title, 
        body.assigneeId, 
        body.dueDate ? new Date(body.dueDate) : undefined // Converte string para Date
      ),
    );
    return { taskId };
  }

  @Get()
  async list(@Param('projectId') projectId: string) {
    return this.queryBus.execute(new GetTasksQuery(projectId));
  }
}